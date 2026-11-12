import { join } from "node:path";
import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import { HttpJwtAuthorizer } from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cloudwatch_actions from "aws-cdk-lib/aws-cloudwatch-actions";
import type * as cognito from "aws-cdk-lib/aws-cognito";
import type * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as iam from "aws-cdk-lib/aws-iam";
import type * as lambda from "aws-cdk-lib/aws-lambda";
import { SqsEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import type { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as sns from "aws-cdk-lib/aws-sns";
import * as sqs from "aws-cdk-lib/aws-sqs";
import type { Construct } from "constructs";
import { makeFn } from "./fn";

export interface PortalStackProps extends StackProps {
  stage: string;
  table: dynamodb.ITable;
  userPool: cognito.IUserPool;
  /** Cognito app clients whose tokens the portal accepts: the website client (+ the dev test client). */
  audienceClientIds: string[];
}

/** Browser origins of the portal web app per stage. Extra origins via context `niltv:portalOrigins:{stage}` (comma list). */
export const portalOrigins = (stage: string, extra: string | undefined): string[] => [
  ...(stage === "prod" ? ["https://portal.niltv.com"] : ["https://portal-dev.niltv.com", "http://localhost:5190"]),
  ...(extra ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
];

/**
 * Partition prefixes the portal owns (src/lib/db.ts, Portal section). USER#*
 * is needed because member, membership and availability rows live in the
 * account's own partition, so DELETE /v1/me removes them with the account.
 */
export const PORTAL_LEADING_KEYS = [
  "USER#*",
  "PORTAL#*",
  "CONV#*",
  "CONVS#ALL",
  "DESK#*",
  "NOTIFY#DUE",
  "PEVENT#*",
  "PEVENTS#ALL",
  "AVAIL#ALL",
  "POSTING#*",
  "POSTINGS#ALL",
  "ASK#*",
  "ASKS#ALL",
  "PREQ#*",
  "PREQS#ALL",
];

/**
 * NIL TV Portal API (portal.niltv.com): its own HTTP API, direct to
 * execute-api like the admin API (small, private, uncacheable traffic).
 * Two authorization layers, both fail closed:
 *
 *   1. Cognito JWT authorizer on every route: a valid niltv.com sign-in.
 *   2. In every handler: an active USER#{sub} / PORTAL row, and a role that
 *      allows the action (src/lib/portal/access.ts).
 *
 * Notifications go through a queue: request handlers enqueue a notice,
 * portal-notify pushes and queues summary emails (retries, then a
 * dead-letter queue), and portal-summary sends the summaries and desk
 * alerts every 15 minutes. Admin switches in Settings keep both off until
 * testing ends. Push keys (VAPID) live in SSM; scripts/portal-vapid.ts
 * creates them.
 */
export class PortalStack extends Stack {
  public readonly httpApi: apigwv2.HttpApi;

  constructor(scope: Construct, id: string, props: PortalStackProps) {
    super(scope, id, props);
    const { stage, table, userPool, audienceClientIds } = props;

    const portalUrl =
      (this.node.tryGetContext(`niltv:portalUrl:${stage}`) as string | undefined) ??
      (stage === "prod" ? "https://portal.niltv.com" : "https://portal-dev.niltv.com");
    const dashboardApiUrl =
      (this.node.tryGetContext(`niltv:dashboardApiUrl:${stage}`) as string | undefined) ??
      (stage === "prod" ? "https://api.niltv.com" : "https://api-dev.niltv.com");
    const cfDomain = this.node.tryGetContext(`niltv:cfDomain:${stage}`) as string | undefined;
    const origins = portalOrigins(stage, this.node.tryGetContext(`niltv:portalOrigins:${stage}`) as string | undefined);

    const jwtAuthorizer = new HttpJwtAuthorizer(
      "PortalJwtAuthorizer",
      `https://cognito-idp.${this.region}.amazonaws.com/${userPool.userPoolId}`,
      { jwtAudience: audienceClientIds },
    );

    this.httpApi = new apigwv2.HttpApi(this, "HttpApi", {
      apiName: `niltv-${stage}-portal`,
      defaultAuthorizer: jwtAuthorizer,
      corsPreflight: {
        allowOrigins: origins,
        allowMethods: [
          apigwv2.CorsHttpMethod.GET,
          apigwv2.CorsHttpMethod.POST,
          apigwv2.CorsHttpMethod.PUT,
          apigwv2.CorsHttpMethod.PATCH,
          apigwv2.CorsHttpMethod.DELETE,
          apigwv2.CorsHttpMethod.OPTIONS,
        ],
        allowHeaders: ["authorization", "content-type"],
        maxAge: Duration.hours(1),
      },
    });

    // Throttling backstop: a few hundred people polling an inbox. Anything
    // well past this is a stolen token or a runaway client.
    const defaultStage = this.httpApi.defaultStage?.node.defaultChild as apigwv2.CfnStage;
    defaultStage.defaultRouteSettings = { throttlingRateLimit: 50, throttlingBurstLimit: 100 };

    // ── Access log: who called what (one JSON line per request) ───────────
    // The path is logged because routeKey is only the template; it carries
    // conversation ids. Never the Authorization header or any body.
    const accessLogGroup = new logs.LogGroup(this, "AccessLogGroup", {
      logGroupName: `/aws/apigateway/niltv-${stage}-portal-access`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: stage === "dev" ? RemovalPolicy.DESTROY : RemovalPolicy.RETAIN,
    });
    defaultStage.accessLogSettings = {
      destinationArn: accessLogGroup.logGroupArn,
      format: JSON.stringify({
        requestId: "$context.requestId",
        requestTime: "$context.requestTime",
        routeKey: "$context.routeKey",
        path: "$context.path",
        status: "$context.status",
        sourceIp: "$context.identity.sourceIp",
        userAgent: "$context.identity.userAgent",
        sub: "$context.authorizer.claims.sub",
        latencyMs: "$context.responseLatency",
        error: "$context.error.message",
        integrationError: "$context.integrationErrorMessage",
      }),
    };

    // ── Notice queue ──────────────────────────────────────────────────────
    const notifyDlq = new sqs.Queue(this, "NotifyDlq", {
      queueName: `niltv-${stage}-portal-notify-dlq`,
      retentionPeriod: Duration.days(14),
      enforceSSL: true,
    });
    const notifyQueue = new sqs.Queue(this, "NotifyQueue", {
      queueName: `niltv-${stage}-portal-notify`,
      // 6x the consumer timeout, per the Lambda/SQS guidance.
      visibilityTimeout: Duration.minutes(12),
      deadLetterQueue: { queue: notifyDlq, maxReceiveCount: 3 },
      enforceSSL: true,
    });

    // ── Table access: portal partitions only ──────────────────────────────
    const tablePolicy = (leadingKeys: string[]): iam.PolicyStatement =>
      new iam.PolicyStatement({
        actions: [
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
          "dynamodb:DeleteItem",
          "dynamodb:Query",
          "dynamodb:BatchGetItem",
          "dynamodb:BatchWriteItem",
          "dynamodb:ConditionCheckItem",
        ],
        resources: [table.tableArn, `${table.tableArn}/index/*`],
        conditions: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": leadingKeys } },
      });
    // Read-only reach into the catalogue: profile lookup by handle (GSI1
    // PROFILES#ALL) and an athlete's published clips (GSI2 ATHLETE#*).
    const catalogueReadPolicy = new iam.PolicyStatement({
      actions: ["dynamodb:Query"],
      resources: [`${table.tableArn}/index/GSI1`, `${table.tableArn}/index/GSI2`],
      conditions: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["PROFILES#ALL", "ATHLETE#*"] } },
    });
    const listUsersPolicy = new iam.PolicyStatement({
      actions: ["cognito-idp:ListUsers"],
      resources: [userPool.userPoolArn],
    });
    // Only for clearing a sign-up nobody finished, on an address the portal is inviting.
    const clearSignupPolicy = new iam.PolicyStatement({
      actions: ["cognito-idp:AdminDeleteUser"],
      resources: [userPool.userPoolArn],
    });
    const sesPolicy = new iam.PolicyStatement({
      actions: ["ses:SendEmail", "ses:SendRawEmail"],
      // SESv2 authorises against the sending identity and the identity's
      // default configuration set (foundation "niltv-transactional").
      resources: [
        `arn:aws:ses:${this.region}:${this.account}:identity/niltv.com`,
        `arn:aws:ses:${this.region}:${this.account}:configuration-set/niltv-transactional`,
      ],
    });
    // Web push keys: the public key is handed to browsers, the private key
    // signs pushes and only the notifier reads it.
    const vapidPublicParam = `/niltv/${stage}/portal-vapid-public`;
    const vapidPrivateParam = `/niltv/${stage}/portal-vapid-private`;
    const ssmRead = (...names: string[]): iam.PolicyStatement =>
      new iam.PolicyStatement({
        actions: ["ssm:GetParameter"],
        resources: names.map((name) => this.formatArn({ service: "ssm", resource: "parameter", resourceName: name.slice(1) })),
      });
    const emailEnv: Record<string, string> = {
      FROM_EMAIL: "portal@niltv.com",
      ...(cfDomain ? { EMAIL_LOGO_BASE: `https://${cfDomain}` } : {}),
    };

    const portalFn = (fnId: string, name: string, file: string, extraEnv: Record<string, string> = {}): NodejsFunction => {
      const fn = makeFn(this, fnId, {
        stage,
        name: `portal-${name}`,
        entry: join(__dirname, "..", "src", "handlers", "portal", file),
        env: {
          TABLE_NAME: table.tableName,
          NOTIFY_QUEUE_URL: notifyQueue.queueUrl,
          PORTAL_URL: portalUrl,
          ...extraEnv,
        },
      });
      fn.addToRolePolicy(tablePolicy(PORTAL_LEADING_KEYS));
      notifyQueue.grantSendMessages(fn);
      return fn;
    };

    const meFn = portalFn("MeFn", "me", "me.ts", { VAPID_PUBLIC_PARAM: vapidPublicParam });
    meFn.addToRolePolicy(ssmRead(vapidPublicParam));
    const membersFn = portalFn("MembersFn", "members", "members.ts", { USER_POOL_ID: userPool.userPoolId });
    const conversationsFn = portalFn("ConversationsFn", "conversations", "conversations.ts");
    const scheduleFn = portalFn("ScheduleFn", "schedule", "schedule.ts");
    const postingsFn = portalFn("PostingsFn", "postings", "postings.ts");
    const requestsFn = portalFn("RequestsFn", "requests", "requests.ts");

    // Files athletes send through the Content Hub. Their own bucket: nothing
    // here reaches the transcoder or the public catalogue. Browsers upload
    // straight to it with short-lived links; a stalled upload clears itself.
    const submissionsBucket = new s3.Bucket(this, "SubmissionsBucket", {
      bucketName: `niltv-${stage}-portal-submissions-${this.account}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.RETAIN,
      cors: [{ allowedOrigins: origins, allowedMethods: [s3.HttpMethods.PUT], allowedHeaders: ["*"], maxAge: 3600 }],
      lifecycleRules: [{ abortIncompleteMultipartUploadAfter: Duration.days(7) }],
    });
    const asksFn = portalFn("AsksFn", "asks", "asks.ts", { SUBMISSIONS_BUCKET: submissionsBucket.bucketName });
    asksFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["s3:PutObject", "s3:GetObject", "s3:DeleteObject", "s3:AbortMultipartUpload", "s3:ListMultipartUploadParts"],
        resources: [submissionsBucket.arnForObjects("submissions/*")],
      }),
    );
    const postsFn = portalFn("PostsFn", "posts", "posts.ts", cfDomain ? { PLAYBACK_BASE_URL: `https://${cfDomain}` } : {});
    membersFn.addToRolePolicy(listUsersPolicy);
    membersFn.addToRolePolicy(clearSignupPolicy);
    postsFn.addToRolePolicy(catalogueReadPolicy);

    // ── Notifier (SQS consumer) ───────────────────────────────────────────
    const notifyFn = makeFn(this, "NotifyFn", {
      stage,
      name: "portal-notify",
      entry: join(__dirname, "..", "src", "handlers", "portal", "notify.ts"),
      timeout: Duration.minutes(2),
      env: {
        TABLE_NAME: table.tableName,
        PORTAL_URL: portalUrl,
        VAPID_PUBLIC_PARAM: vapidPublicParam,
        VAPID_PRIVATE_PARAM: vapidPrivateParam,
        ...emailEnv,
      },
    });
    notifyFn.addToRolePolicy(tablePolicy(PORTAL_LEADING_KEYS));
    notifyFn.addToRolePolicy(sesPolicy);
    notifyFn.addToRolePolicy(ssmRead(vapidPublicParam, vapidPrivateParam));
    notifyFn.addEventSource(
      new SqsEventSource(notifyQueue, { batchSize: 10, reportBatchItemFailures: true }),
    );

    // ── Summary emails and desk alerts (every 15 minutes, one run at a time) ─
    const summaryFn = makeFn(this, "SummaryFn", {
      stage,
      name: "portal-summary",
      entry: join(__dirname, "..", "src", "handlers", "portal", "summary.ts"),
      timeout: Duration.minutes(5),
      env: { TABLE_NAME: table.tableName, PORTAL_URL: portalUrl, ...emailEnv },
    });
    (summaryFn.node.defaultChild as lambda.CfnFunction).reservedConcurrentExecutions = 1;
    summaryFn.addToRolePolicy(tablePolicy(PORTAL_LEADING_KEYS));
    summaryFn.addToRolePolicy(sesPolicy);
    new events.Rule(this, "SummarySchedule", {
      ruleName: `niltv-${stage}-portal-summary`,
      description: "Portal summary emails and desk alerts (nothing sends while Settings has them off)",
      schedule: events.Schedule.rate(Duration.minutes(15)),
      targets: [new targets.LambdaFunction(summaryFn)],
    });

    // ── Roster sync: accepted onboarding athletes → portal members ────────
    const apiKeyParamName = `/niltv/${stage}/dashboard-api-key`;
    const rosterSyncFn = makeFn(this, "RosterSyncFn", {
      stage,
      name: "portal-roster-sync",
      entry: join(__dirname, "..", "src", "handlers", "portal", "roster-sync.ts"),
      timeout: Duration.minutes(5),
      env: {
        TABLE_NAME: table.tableName,
        NOTIFY_QUEUE_URL: notifyQueue.queueUrl,
        PORTAL_URL: portalUrl,
        USER_POOL_ID: userPool.userPoolId,
        DASHBOARD_API_URL: dashboardApiUrl,
        DASHBOARD_API_KEY_PARAM: apiKeyParamName,
      },
    });
    rosterSyncFn.addToRolePolicy(tablePolicy(PORTAL_LEADING_KEYS));
    rosterSyncFn.addToRolePolicy(catalogueReadPolicy);
    rosterSyncFn.addToRolePolicy(listUsersPolicy);
    rosterSyncFn.addToRolePolicy(clearSignupPolicy);
    notifyQueue.grantSendMessages(rosterSyncFn);
    rosterSyncFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ssm:GetParameter"],
        resources: [this.formatArn({ service: "ssm", resource: "parameter", resourceName: apiKeyParamName.slice(1) })],
      }),
    );
    // Scheduled on prod. Elsewhere only when context turns it on: the dev
    // dashboard has its own API key, and dev should not mirror real applicants.
    const syncOn = stage === "prod" || this.node.tryGetContext(`niltv:portalRosterSync:${stage}`) === "on";
    if (syncOn) {
      new events.Rule(this, "RosterSyncSchedule", {
        ruleName: `niltv-${stage}-portal-roster-sync`,
        description: "Accepted athletes from dashboard onboarding into the portal",
        schedule: events.Schedule.rate(Duration.minutes(30)),
        targets: [new targets.LambdaFunction(rosterSyncFn)],
      });
    }

    // ── Routes ────────────────────────────────────────────────────────────
    const M = apigwv2.HttpMethod;
    const routes: [string, apigwv2.HttpMethod[], NodejsFunction][] = [
      ["/v1/me", [M.GET, M.PATCH], meFn],
      ["/v1/push", [M.GET, M.POST], meFn],
      ["/v1/push/remove", [M.POST], meFn],
      ["/v1/members", [M.GET, M.POST], membersFn],
      ["/v1/members/{sub}", [M.PATCH], membersFn],
      ["/v1/athletes/pending", [M.GET], membersFn],
      ["/v1/athletes/pending/{id}/invite", [M.POST], membersFn],
      ["/v1/athletes/pending/{id}/link", [M.POST], membersFn],
      ["/v1/settings", [M.GET, M.PUT], membersFn],
      ["/v1/inbox", [M.GET], conversationsFn],
      ["/v1/desks", [M.POST], conversationsFn],
      ["/v1/groups", [M.POST], conversationsFn],
      ["/v1/groups/{id}", [M.PUT], conversationsFn],
      ["/v1/conversations/{id}", [M.GET], conversationsFn],
      ["/v1/conversations/{id}/messages", [M.GET, M.POST], conversationsFn],
      ["/v1/conversations/{id}/people", [M.GET], conversationsFn],
      ["/v1/conversations/{id}/read", [M.POST], conversationsFn],
      ["/v1/conversations/{id}/mute", [M.PUT], conversationsFn],
      ["/v1/conversations/{id}/messages/{messageId}/hide", [M.POST], conversationsFn],
      ["/v1/events", [M.GET, M.POST], scheduleFn],
      ["/v1/events/{id}", [M.PUT], scheduleFn],
      ["/v1/events/{id}/action", [M.POST], scheduleFn],
      ["/v1/availability", [M.GET, M.PUT], scheduleFn],
      ["/v1/availability/heatmap", [M.GET], scheduleFn],
      ["/v1/postings", [M.GET, M.POST], postingsFn],
      ["/v1/postings/{id}", [M.PUT], postingsFn],
      ["/v1/postings/{id}/action", [M.POST], postingsFn],
      ["/v1/asks", [M.GET, M.POST], asksFn],
      ["/v1/asks/images", [M.POST], asksFn],
      ["/v1/asks/{id}", [M.PUT], asksFn],
      ["/v1/asks/{id}/action", [M.POST], asksFn],
      ["/v1/asks/{id}/uploads", [M.POST], asksFn],
      ["/v1/asks/{id}/uploads/{fileId}", [M.DELETE], asksFn],
      ["/v1/asks/{id}/uploads/{fileId}/part", [M.POST], asksFn],
      ["/v1/asks/{id}/uploads/{fileId}/complete", [M.POST], asksFn],
      ["/v1/asks/{id}/files/{sub}/{fileId}", [M.GET], asksFn],
      ["/v1/requests", [M.GET, M.POST], requestsFn],
      ["/v1/requests/{id}", [M.PATCH], requestsFn],
      ["/v1/help", [M.POST], requestsFn],
      ["/v1/my-posts", [M.GET], postsFn],
    ];
    const integrations = new Map<NodejsFunction, HttpLambdaIntegration>();
    for (const [path, methods, fn] of routes) {
      let integration = integrations.get(fn);
      if (!integration) {
        integration = new HttpLambdaIntegration(`${fn.node.id}Integration`, fn);
        integrations.set(fn, integration);
      }
      this.httpApi.addRoutes({ path, methods, integration });
    }

    // ── Alarms → the api stack's alerts topic ──────────────────────────────
    // The router turns a thrown route into a 500, so Lambda Errors stays at 0
    // for API handlers and the API 5xx metric is their only signal.
    const alertsTopic = sns.Topic.fromTopicArn(
      this,
      "AlertsTopic",
      this.formatArn({ service: "sns", resource: `niltv-${stage}-alerts` }),
    );
    const alarmAction = new cloudwatch_actions.SnsAction(alertsTopic);
    const alarm = (id: string, name: string, description: string, metric: cloudwatch.IMetric, threshold = 1): void => {
      new cloudwatch.Alarm(this, id, {
        alarmName: `niltv-${stage}-${name}`,
        alarmDescription: description,
        metric,
        threshold,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }).addAlarmAction(alarmAction);
    };
    const fiveMin = { period: Duration.minutes(5) };
    alarm(
      "Api5xxAlarm",
      "portal-api-5xx",
      "Portal API served at least one 5xx in 5 minutes",
      this.httpApi.metricServerError({ ...fiveMin, statistic: "sum" }),
    );
    for (const [fnId, name, fn] of [
      ["NotifyFn", "portal-notify", notifyFn],
      ["SummaryFn", "portal-summary", summaryFn],
      ["RosterSyncFn", "portal-roster-sync", rosterSyncFn],
    ] as const) {
      alarm(
        `${fnId}ErrorsAlarm`,
        `${name}-errors`,
        `niltv-${stage}-${name} reported at least one invocation error in 5 minutes`,
        fn.metricErrors({ ...fiveMin, statistic: "sum" }),
      );
    }
    alarm(
      "NotifyDlqAlarm",
      "portal-notify-dlq",
      "A portal notice used up its retries and is in the dead-letter queue. Redrive steps are in docs/portal.md.",
      notifyDlq.metricApproximateNumberOfMessagesVisible({ ...fiveMin, statistic: "max" }),
    );
    alarm(
      "NotifyQueueAgeAlarm",
      "portal-notify-queue-age",
      "The oldest portal notice has waited 15 minutes or more. The notifier is stuck or failing.",
      notifyQueue.metricApproximateAgeOfOldestMessage({ ...fiveMin, statistic: "max" }),
      Duration.minutes(15).toSeconds(),
    );

    // Paths that log and carry on (a failed email, push or enqueue). One
    // metric across every portal function, so a quiet failure still pages.
    const swallowedMetric = { namespace: "NILTV/Portal", name: `${stage}-swallowed-errors` };
    const swallowedPattern = logs.FilterPattern.anyTerm(
      "email failed",
      "one recipient failed",
      "one summary failed",
      "desk alert failed",
      "notice enqueue failed",
    );
    const allFns: [string, NodejsFunction][] = [
      ["MeFn", meFn],
      ["MembersFn", membersFn],
      ["ConversationsFn", conversationsFn],
      ["ScheduleFn", scheduleFn],
      ["PostingsFn", postingsFn],
      ["RequestsFn", requestsFn],
      ["AsksFn", asksFn],
      ["PostsFn", postsFn],
      ["NotifyFn", notifyFn],
      ["SummaryFn", summaryFn],
      ["RosterSyncFn", rosterSyncFn],
    ];
    for (const [fnId, fn] of allFns) {
      new logs.MetricFilter(this, `${fnId}SwallowedErrors`, {
        logGroup: fn.logGroup,
        filterPattern: swallowedPattern,
        metricNamespace: swallowedMetric.namespace,
        metricName: swallowedMetric.name,
        metricValue: "1",
      });
    }
    alarm(
      "SwallowedErrorsAlarm",
      "portal-swallowed-errors",
      "A portal email, push or notice failed and the code carried on. Search the portal log groups for 'failed'.",
      new cloudwatch.Metric({
        namespace: swallowedMetric.namespace,
        metricName: swallowedMetric.name,
        ...fiveMin,
        statistic: "sum",
      }),
    );

    // SES sending reputation is account-wide, and dev and prod share the
    // account, so only the prod stack owns these. AWS reviews an account at
    // a 5% bounce rate or a 0.1% complaint rate; these page before that.
    if (stage === "prod") {
      const reputation = (metricName: string) =>
        new cloudwatch.Metric({ namespace: "AWS/SES", metricName, period: Duration.hours(1), statistic: "max" });
      alarm(
        "SesBounceRateAlarm",
        "ses-bounce-rate",
        "SES bounce rate reached 4%. AWS reviews the account at 5%.",
        reputation("Reputation.BounceRate"),
        0.04,
      );
      alarm(
        "SesComplaintRateAlarm",
        "ses-complaint-rate",
        "SES complaint rate reached 0.08%. AWS reviews the account at 0.1%.",
        reputation("Reputation.ComplaintRate"),
        0.0008,
      );
    }

    new CfnOutput(this, "PortalApiUrl", { value: this.httpApi.apiEndpoint });
    new CfnOutput(this, "AccessLogGroupName", { value: accessLogGroup.logGroupName });
    new CfnOutput(this, "NotifyDlqName", { value: notifyDlq.queueName });
  }
}
