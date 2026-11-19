import { join } from "node:path";
import { CfnOutput, Duration, Stack, type StackProps } from "aws-cdk-lib";
import type * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as iam from "aws-cdk-lib/aws-iam";
import type * as s3 from "aws-cdk-lib/aws-s3";
import type { Construct } from "constructs";
import { makeFn } from "./fn";

export interface IngestStackProps extends StackProps {
  stage: string;
  table: dynamodb.ITable;
  /** The media stack's HLS output bucket (CloudFront /video/*) — ingested mp4s + posters land here directly. */
  outputBucket: s3.IBucket;
  /** Masters bucket — archives the pristine original before a clip is re-compressed. */
  mastersBucket: s3.IBucket;
}

/**
 * Social ingest bridge — the app's PRIMARY content path: a scheduled Lambda
 * pulls collected Instagram posts from the niltv_dashboard REST API and
 * publishes new videos directly (mp4 + poster into the output bucket, row
 * pre-published — no MediaConvert; see src/handlers/ingest/ingest-social.ts).
 *
 * Schedule: hourly at :30, after the dashboard has refreshed posts AND their
 * short-lived IG media URLs. The run is idempotent and returns in seconds
 * when nothing is new.
 *
 * The dashboard API key lives in SSM Parameter Store (SecureString,
 * /niltv/{stage}/dashboard-api-key) — created out-of-band, never in git.
 * On prod the run also dispatches the web repo's Deploy Prod workflow after
 * it publishes new clips, using a GitHub token in SSM
 * (/niltv/prod/site-deploy-token), also created out-of-band.
 */
export class IngestStack extends Stack {
  constructor(scope: Construct, id: string, props: IngestStackProps) {
    super(scope, id, props);
    const { stage, table, outputBucket, mastersBucket } = props;

    const apiKeyParamName = `/niltv/${stage}/dashboard-api-key`;
    const siteDeployTokenParamName = `/niltv/${stage}/site-deploy-token`;

    // Referenced by name, not by importing the media stack's Role construct:
    // the role name is fixed there (`niltv-{stage}-mediaconvert`) and taking
    // the object would add a cross-stack dependency for no benefit.
    const mediaConvertRoleArn = this.formatArn({
      service: "iam",
      region: "",
      resource: "role",
      resourceName: `niltv-${stage}-mediaconvert`,
    });
    const mediaConvertQueueArn = this.formatArn({
      service: "mediaconvert",
      resource: "queues",
      resourceName: "Default",
    });

    const ingestFn = makeFn(this, "IngestSocialFn", {
      stage,
      name: "ingest-social",
      entry: join(__dirname, "..", "src", "handlers", "ingest", "ingest-social.ts"),
      // Buffers whole video masters in memory (IG reels are tens of MB) and
      // walks up to MAX_NEW_PER_RUN posts sequentially.
      memorySize: 1536,
      timeout: Duration.minutes(10),
      env: {
        TABLE_NAME: table.tableName,
        OUTPUT_BUCKET: outputBucket.bucketName,
        DASHBOARD_API_URL: "https://api.niltv.com",
        DASHBOARD_API_KEY_PARAM: apiKeyParamName,
        MAX_NEW_PER_RUN: "50",
        STAGE: stage,
        MASTERS_BUCKET: mastersBucket.bucketName,
        MEDIACONVERT_ROLE_ARN: mediaConvertRoleArn,
        MEDIACONVERT_QUEUE_ARN: mediaConvertQueueArn,
      },
    });

    // Library sync to the dashboard (src/lib/library-sync.ts): after each run
    // the bridge POSTs the whole labelled library to the dashboard's
    // /api/library/sync. Context `niltv:librarySync:{stage}`; defaults to on
    // in dev and off in prod until the dashboard endpoint ships there. It
    // reads with the table grant below and its own dashboard API key.
    const librarySyncEnabled =
      (this.node.tryGetContext(`niltv:librarySync:${stage}`) as string | undefined) ?? (stage === "dev" ? "true" : "false");
    ingestFn.addEnvironment("LIBRARY_SYNC_ENABLED", librarySyncEnabled);
    // The sync targets the stage's own dashboard, never the shared
    // DASHBOARD_API_URL above (which reads prod brand posts in every stage):
    // a dev snapshot must not land in the prod dashboard. Same context key and
    // defaults as the portal stack.
    const librarySyncUrl =
      (this.node.tryGetContext(`niltv:dashboardApiUrl:${stage}`) as string | undefined) ??
      (stage === "prod" ? "https://api.niltv.com" : "https://api-dev.niltv.com");
    ingestFn.addEnvironment("LIBRARY_SYNC_URL", librarySyncUrl);
    // The dev and prod dashboards take different keys, so the sync reads its
    // own SSM parameter. Prod defaults to the brand-read key (same dashboard);
    // dev to the dev dashboard's key. Context `niltv:librarySyncKeyParam:{stage}`.
    const librarySyncKeyParamName =
      (this.node.tryGetContext(`niltv:librarySyncKeyParam:${stage}`) as string | undefined) ??
      (stage === "prod" ? apiKeyParamName : `/niltv/${stage}/dashboard-dev-api-key`);
    ingestFn.addEnvironment("LIBRARY_SYNC_API_KEY_PARAM", librarySyncKeyParamName);

    // Same pattern as the api stack: the CloudFront domain comes from cdk.json
    // context so the handler can compose public download URLs for the
    // content-library CSV.
    const cfDomain = this.node.tryGetContext(`niltv:cfDomain:${stage}`) as string | undefined;
    if (cfDomain) {
      ingestFn.addEnvironment("PLAYBACK_BASE_URL", `https://${cfDomain}`);
    }
    // Only prod rebuilds niltv.com; the dev ingest mirrors the same posts and
    // must not trigger a production deploy.
    if (stage === "prod") {
      ingestFn.addEnvironment("SITE_DEPLOY_TOKEN_PARAM", siteDeployTokenParamName);
      ingestFn.addEnvironment("SITE_DEPLOY_REPO", "NILTVdev/niltv-web");
    }

    table.grantReadWriteData(ingestFn);
    // video/* — mirrored clips + posters; library/* — the content-library CSV
    // (served short-cache at /library/*, see the edge stack).
    ingestFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["s3:PutObject"],
        resources: [outputBucket.arnForObjects("video/*"), outputBucket.arnForObjects("library/*")],
      }),
    );
    // Over-encoded clips are archived and re-compressed (see
    // queueRecompressionIfOverEncoded). Writes are scoped to the archive
    // prefix — `masters/` is the HLS pipeline's trigger and must stay
    // untouchable from here.
    ingestFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["s3:PutObject"],
        resources: [mastersBucket.arnForObjects("originals/*")],
      }),
    );
    ingestFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["mediaconvert:CreateJob"],
        resources: [mediaConvertQueueArn],
      }),
    );
    ingestFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["iam:PassRole"],
        resources: [mediaConvertRoleArn],
      }),
    );
    ingestFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ssm:GetParameter"],
        resources: [
          this.formatArn({ service: "ssm", resource: "parameter", resourceName: apiKeyParamName.slice(1) }),
          this.formatArn({ service: "ssm", resource: "parameter", resourceName: siteDeployTokenParamName.slice(1) }),
          ...(librarySyncKeyParamName !== apiKeyParamName
            ? [this.formatArn({ service: "ssm", resource: "parameter", resourceName: librarySyncKeyParamName.replace(/^\//, "") })]
            : []),
        ],
      }),
    );

    // ── roster-import (content foundation): dashboard ambassadors → Profile rows
    // Runs at 06:15, after the dashboard's collab pull and before the content
    // bridge, so a newly welcomed ambassador has a profile before their first
    // collab clip is enriched.
    const rosterFn = makeFn(this, "RosterImportFn", {
      stage,
      name: "roster-import",
      entry: join(__dirname, "..", "src", "handlers", "ingest", "roster-import.ts"),
      timeout: Duration.minutes(2),
      env: {
        TABLE_NAME: table.tableName,
        DASHBOARD_API_URL: "https://api.niltv.com",
        DASHBOARD_API_KEY_PARAM: apiKeyParamName,
      },
    });
    rosterFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["dynamodb:PutItem"],
        resources: [table.tableArn],
        conditions: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["ATHLETE#*"] } },
      }),
    );
    rosterFn.addToRolePolicy(
      new iam.PolicyStatement({ actions: ["dynamodb:Query"], resources: [`${table.tableArn}/index/GSI1`] }),
    );
    rosterFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ssm:GetParameter"],
        resources: [
          this.formatArn({ service: "ssm", resource: "parameter", resourceName: apiKeyParamName.slice(1) }),
        ],
      }),
    );
    new events.Rule(this, "RosterScheduleRule", {
      ruleName: `niltv-${stage}-roster-import`,
      description: "Daily roster sync from the dashboard's ambassadors table",
      schedule: events.Schedule.cron({ minute: "15", hour: "6" }),
      targets: [new targets.LambdaFunction(rosterFn)],
    });

    new events.Rule(this, "IngestScheduleRule", {
      ruleName: `niltv-${stage}-ingest-social`,
      description: "Hourly social-post ingest, after the dashboard's IG pulls (:10 brand, :15 network)",
      schedule: events.Schedule.cron({ minute: "30", hour: "*" }),
      targets: [new targets.LambdaFunction(ingestFn)],
    });

    new CfnOutput(this, "IngestFunctionName", { value: ingestFn.functionName });
  }
}
