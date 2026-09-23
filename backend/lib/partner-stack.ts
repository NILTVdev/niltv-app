import { join } from "node:path";
import { CfnOutput, Duration, Stack, type StackProps } from "aws-cdk-lib";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cloudwatch_actions from "aws-cdk-lib/aws-cloudwatch-actions";
import type * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { DynamoEventSource, SqsDlq, SqsEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import type { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import type * as s3 from "aws-cdk-lib/aws-s3";
import * as sns from "aws-cdk-lib/aws-sns";
import * as sqs from "aws-cdk-lib/aws-sqs";
import type { Construct } from "constructs";
import { makeFn } from "./fn";

export interface PartnerStackProps extends StackProps {
  stage: string;
  table: dynamodb.ITable;
  /** The media stack's video bucket — feeds are written under feeds/* and served at /feeds/* by the edge stack. */
  outputBucket: s3.IBucket;
}

/** SSM parameter names the edge stack publishes for the partner download distribution. */
export const partnerDlParams = (stage: string): { domain: string; keyPairId: string } => ({
  domain: `/niltv/${stage}/partner-dl/domain`,
  keyPairId: `/niltv/${stage}/partner-dl/key-pair-id`,
});

/** Secrets Manager name of the RSA private key (scripts/partner-dl-keypair.ts). */
export const partnerDlSecretName = (stage: string): string => `niltv/${stage}/partner-dl-private-key`;

/**
 * Partner content API — the asynchronous half. The request path lives in the
 * api stack; this stack owns everything that runs on a schedule or off the
 * table stream:
 *
 *   feed-build       every 15 min → Media RSS + JSON per partner → video bucket feeds/*
 *   partner-events   table stream → lifecycle events → webhook queue (per interested partner)
 *   webhook-deliver  queue → signed POST to the partner, retries via SQS, DLQ + alarm
 *
 * Nothing here is reachable from the internet; nothing here writes to a
 * content row. Alarms page the api stack's alerts topic (referenced by name).
 */
export class PartnerStack extends Stack {
  constructor(scope: Construct, id: string, props: PartnerStackProps) {
    super(scope, id, props);
    const { stage, table, outputBucket } = props;

    const cfDomain = this.node.tryGetContext(`niltv:cfDomain:${stage}`) as string | undefined;
    const siteOrigin = stage === "prod" ? "https://niltv.com" : "https://dev.dkdfgvugisb3v.amplifyapp.com";
    const params = partnerDlParams(stage);
    const signingEnv = {
      PARTNER_DL_DOMAIN_PARAM: params.domain,
      PARTNER_DL_KEYPAIR_PARAM: params.keyPairId,
      PARTNER_DL_PRIVATE_KEY_SECRET: partnerDlSecretName(stage),
    };
    const signingPolicies = [
      new iam.PolicyStatement({
        actions: ["ssm:GetParameter"],
        resources: [
          this.formatArn({ service: "ssm", resource: "parameter", resourceName: params.domain.slice(1) }),
          this.formatArn({ service: "ssm", resource: "parameter", resourceName: params.keyPairId.slice(1) }),
        ],
      }),
      new iam.PolicyStatement({
        actions: ["secretsmanager:GetSecretValue"],
        resources: [
          `arn:${this.partition}:secretsmanager:${this.region}:${this.account}:secret:${partnerDlSecretName(stage)}-*`,
        ],
      }),
    ];

    const keyScoped = (actions: string[], leadingKeys: string[]): iam.PolicyStatement =>
      new iam.PolicyStatement({
        actions,
        resources: [table.tableArn],
        conditions: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": leadingKeys } },
      });
    const gsi1Query = new iam.PolicyStatement({ actions: ["dynamodb:Query"], resources: [`${table.tableArn}/index/GSI1`] });
    const gsi3Query = new iam.PolicyStatement({ actions: ["dynamodb:Query"], resources: [`${table.tableArn}/index/GSI3`] });

    // ── feed-build ─────────────────────────────────────────────────────────
    const feedBuildFn: NodejsFunction = makeFn(this, "FeedBuildFn", {
      stage,
      name: "partner-feed-build",
      entry: join(__dirname, "..", "src", "handlers", "partner-jobs", "feed-build.ts"),
      memorySize: 1024,
      timeout: Duration.minutes(5),
      env: {
        TABLE_NAME: table.tableName,
        OUTPUT_BUCKET: outputBucket.bucketName,
        SITE_ORIGIN: siteOrigin,
        ...(cfDomain ? { PLAYBACK_BASE_URL: `https://${cfDomain}` } : {}),
        ...signingEnv,
      },
    });
    feedBuildFn.addToRolePolicy(gsi1Query);
    feedBuildFn.addToRolePolicy(gsi3Query);
    feedBuildFn.addToRolePolicy(
      keyScoped(["dynamodb:BatchGetItem"], ["SERIES#*", "CHANNEL#*", "ATHLETE#*"]),
    );
    feedBuildFn.addToRolePolicy(
      new iam.PolicyStatement({ actions: ["s3:PutObject"], resources: [outputBucket.arnForObjects("feeds/*")] }),
    );
    for (const policy of signingPolicies) feedBuildFn.addToRolePolicy(policy);

    new events.Rule(this, "FeedBuildSchedule", {
      ruleName: `niltv-${stage}-partner-feed-build`,
      description: "Rebuild every partner's Media RSS + JSON feed",
      schedule: events.Schedule.rate(Duration.minutes(15)),
      targets: [new targets.LambdaFunction(feedBuildFn)],
    });

    // ── webhook queue + deliverer ──────────────────────────────────────────
    const webhookDlq = new sqs.Queue(this, "WebhookDlq", {
      queueName: `niltv-${stage}-partner-webhook-dlq`,
      retentionPeriod: Duration.days(14),
      enforceSSL: true,
    });
    const webhookQueue = new sqs.Queue(this, "WebhookQueue", {
      queueName: `niltv-${stage}-partner-webhooks`,
      // A partner endpoint that is down gets five attempts across ~25 minutes
      // before the message parks in the DLQ (visibility × maxReceiveCount).
      visibilityTimeout: Duration.minutes(5),
      retentionPeriod: Duration.days(4),
      enforceSSL: true,
      deadLetterQueue: { queue: webhookDlq, maxReceiveCount: 5 },
    });

    const webhookDeliverFn = makeFn(this, "WebhookDeliverFn", {
      stage,
      name: "partner-webhook-deliver",
      entry: join(__dirname, "..", "src", "handlers", "partner-jobs", "webhook-deliver.ts"),
      timeout: Duration.seconds(30),
      env: { TABLE_NAME: table.tableName },
    });
    webhookDeliverFn.addEventSource(
      new SqsEventSource(webhookQueue, { batchSize: 10, reportBatchItemFailures: true }),
    );
    webhookDeliverFn.addToRolePolicy(keyScoped(["dynamodb:GetItem", "dynamodb:PutItem"], ["PARTNER#*"]));

    // ── partner-events (table stream → queue) ──────────────────────────────
    const eventsFn = makeFn(this, "PartnerEventsFn", {
      stage,
      name: "partner-events",
      entry: join(__dirname, "..", "src", "handlers", "partner-jobs", "partner-events.ts"),
      env: { TABLE_NAME: table.tableName, WEBHOOK_QUEUE_URL: webhookQueue.queueUrl },
    });
    const eventsDlq = new sqs.Queue(this, "PartnerEventsDlq", {
      queueName: `niltv-${stage}-partner-events-dlq`,
      retentionPeriod: Duration.days(14),
      enforceSSL: true,
    });
    eventsFn.addEventSource(
      new DynamoEventSource(table, {
        startingPosition: lambda.StartingPosition.LATEST,
        batchSize: 25,
        retryAttempts: 3,
        bisectBatchOnError: true,
        reportBatchItemFailures: true,
        onFailure: new SqsDlq(eventsDlq),
      }),
    );
    eventsFn.addToRolePolicy(gsi1Query);
    webhookQueue.grantSendMessages(eventsFn);

    // ── Alarms → the api stack's alerts topic ──────────────────────────────
    const alertsTopic = sns.Topic.fromTopicArn(
      this,
      "AlertsTopic",
      this.formatArn({ service: "sns", resource: `niltv-${stage}-alerts` }),
    );
    const alarmAction = new cloudwatch_actions.SnsAction(alertsTopic);
    const errorsAlarm = (fnId: string, name: string, fn: NodejsFunction) => {
      const alarm = new cloudwatch.Alarm(this, `${fnId}ErrorsAlarm`, {
        alarmName: `niltv-${stage}-${name}-errors`,
        alarmDescription: `niltv-${stage}-${name} reported ≥1 invocation error in 5 minutes`,
        metric: fn.metricErrors({ period: Duration.minutes(5), statistic: "sum" }),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
      alarm.addAlarmAction(alarmAction);
    };
    errorsAlarm("FeedBuildFn", "partner-feed-build", feedBuildFn);
    errorsAlarm("PartnerEventsFn", "partner-events", eventsFn);
    // The deliverer throws on purpose to trigger retries; its signal is the DLQ.
    const dlqAlarm = new cloudwatch.Alarm(this, "WebhookDlqAlarm", {
      alarmName: `niltv-${stage}-partner-webhook-dlq`,
      alarmDescription: "A partner webhook exhausted its retries — a partner missed a lifecycle event",
      metric: webhookDlq.metricApproximateNumberOfMessagesVisible({ period: Duration.minutes(5), statistic: "max" }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    dlqAlarm.addAlarmAction(alarmAction);

    new CfnOutput(this, "WebhookQueueUrl", { value: webhookQueue.queueUrl });
    new CfnOutput(this, "FeedBuildFunctionName", { value: feedBuildFn.functionName });
  }
}
