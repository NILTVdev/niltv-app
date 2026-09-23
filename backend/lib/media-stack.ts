import { join } from "node:path";
import { CfnOutput, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import type * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3n from "aws-cdk-lib/aws-s3-notifications";
import type { Construct } from "constructs";
import { makeFn } from "./fn";

export interface MediaStackProps extends StackProps {
  stage: string;
  table: dynamodb.ITable;
}

/**
 * Video ingest pipeline (design §6.8):
 *
 *   masters bucket (masters/{contentId}/{filename})
 *     → S3 ObjectCreated → start-transcode Lambda → MediaConvert CreateJob
 *     → HLS ladder + poster + partner mezzanine (mezz.mp4) into the output
 *       bucket (video/{contentId}/…); masters/{contentId}/vertical.mp4 → a
 *       mezzanine-only job for the 9:16 cut (partner content API)
 *     → EventBridge job-state COMPLETE/ERROR → transcode-complete Lambda
 *     → stamps transcodeStatus/playbackPath/thumbPath/durationSec on the
 *       CONTENT#{id}/META row.
 *
 * The output bucket is served by CloudFront under /video/* (edge stack).
 */
export class MediaStack extends Stack {
  /** Uploaded video masters (staff uploads land under masters/{contentId}/). */
  public readonly mastersBucket: s3.Bucket;
  /** Transcoded HLS renditions + posters, read by CloudFront via OAC. */
  public readonly outputBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: MediaStackProps) {
    super(scope, id, props);
    const { stage, table } = props;

    const isDev = stage === "dev";
    const removalPolicy = isDev ? RemovalPolicy.DESTROY : RemovalPolicy.RETAIN;

    // ── Buckets ────────────────────────────────────────────────────────────
    this.mastersBucket = new s3.Bucket(this, "MastersBucket", {
      bucketName: `niltv-${stage}-video-masters-${this.account}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy,
      autoDeleteObjects: isDev,
      // The admin tool uploads masters via presigned PUT from the browser —
      // a cross-origin XHR, so the bucket itself must answer CORS preflights.
      // TODO: add the hosted admin origin when the tool moves off localhost.
      cors: [
        {
          allowedOrigins: ["http://localhost:5180"],
          allowedMethods: [s3.HttpMethods.PUT],
          allowedHeaders: ["content-type"],
          maxAge: 3600,
        },
      ],
    });

    this.outputBucket = new s3.Bucket(this, "OutputBucket", {
      bucketName: `niltv-${stage}-video-hls-${this.account}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy,
      autoDeleteObjects: isDev,
      // Browser HLS players fetch manifests/segments cross-origin; CloudFront
      // forwards these CORS headers from the origin. GET-only, public video.
      cors: [
        {
          allowedOrigins: ["*"],
          allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.HEAD],
          allowedHeaders: ["*"],
          maxAge: 86400,
        },
      ],
    });

    // CloudFront (edge stack) reads this bucket through an Origin Access
    // Control. The read statement lives HERE, conditioned on "any CloudFront
    // distribution in this account" (ArnLike …:distribution/*) instead of the
    // exact distribution ARN: referencing the distribution id here while the
    // edge stack references this bucket's domain name would be a cyclic
    // cross-stack dependency. This is the same wildcard pattern the CDK itself
    // applies for cross-stack OAC key policies.
    this.outputBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: "AllowCloudFrontOacRead",
        effect: iam.Effect.ALLOW,
        principals: [new iam.ServicePrincipal("cloudfront.amazonaws.com")],
        actions: ["s3:GetObject"],
        resources: [this.outputBucket.arnForObjects("*")],
        conditions: {
          ArnLike: {
            "AWS:SourceArn": `arn:${this.partition}:cloudfront::${this.account}:distribution/*`,
          },
        },
      }),
    );

    // The partner download distribution (edge stack, partner content API)
    // reads uploads and archived originals through OAC as well — same
    // wildcard-distribution condition, scoped to the two prefixes a partner
    // may ever be handed. Nothing else in this bucket is reachable from CloudFront.
    this.mastersBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: "AllowCloudFrontOacReadPartnerDownloads",
        effect: iam.Effect.ALLOW,
        principals: [new iam.ServicePrincipal("cloudfront.amazonaws.com")],
        actions: ["s3:GetObject"],
        resources: [this.mastersBucket.arnForObjects("masters/*"), this.mastersBucket.arnForObjects("originals/*")],
        conditions: {
          ArnLike: {
            "AWS:SourceArn": `arn:${this.partition}:cloudfront::${this.account}:distribution/*`,
          },
        },
      }),
    );

    // ── MediaConvert execution role ────────────────────────────────────────
    // Assumed by the transcode jobs themselves: read the master, write the
    // HLS renditions + poster.
    const mediaConvertRole = new iam.Role(this, "MediaConvertRole", {
      roleName: `niltv-${stage}-mediaconvert`,
      assumedBy: new iam.ServicePrincipal("mediaconvert.amazonaws.com"),
      description: "Execution role MediaConvert assumes for NILTV transcode jobs",
    });
    this.mastersBucket.grantRead(mediaConvertRole);
    this.outputBucket.grantWrite(mediaConvertRole);

    // Jobs are pinned to the Default (on-demand) queue so the Lambda's
    // mediaconvert:CreateJob permission can be resource-scoped to it.
    const queueArn = this.formatArn({
      service: "mediaconvert",
      resource: "queues",
      resourceName: "Default",
    });

    // ── start-transcode: S3 ObjectCreated (masters/…) → CreateJob ──────────
    const startTranscodeFn = makeFn(this, "StartTranscodeFn", {
      stage,
      name: "start-transcode",
      entry: join(__dirname, "..", "src", "handlers", "media", "start-transcode.ts"),
      env: {
        STAGE: stage,
        OUTPUT_BUCKET: this.outputBucket.bucketName,
        MEDIACONVERT_ROLE_ARN: mediaConvertRole.roleArn,
        MEDIACONVERT_QUEUE_ARN: queueArn,
      },
    });
    startTranscodeFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["mediaconvert:CreateJob"],
        resources: [queueArn],
      }),
    );
    // CreateJob carries the execution role — the Lambda must be allowed to
    // pass it (and only it) to MediaConvert.
    mediaConvertRole.grantPassRole(startTranscodeFn.grantPrincipal);
    startTranscodeFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["s3:GetObject"],
        resources: [this.mastersBucket.arnForObjects("masters/*")],
      }),
    );

    this.mastersBucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.LambdaDestination(startTranscodeFn),
      { prefix: "masters/" },
    );

    // ── transcode-complete: EventBridge job state → CONTENT row ────────────
    const transcodeCompleteFn = makeFn(this, "TranscodeCompleteFn", {
      stage,
      name: "transcode-complete",
      entry: join(__dirname, "..", "src", "handlers", "media", "transcode-complete.ts"),
      env: {
        TABLE_NAME: table.tableName,
      },
    });
    transcodeCompleteFn.addToRolePolicy(
      new iam.PolicyStatement({
        // GetItem: reads the row's autoPublish/rights flags before deciding
        // whether COMPLETE lands as "ready" or auto-publishes (ingest bridge).
        actions: ["dynamodb:UpdateItem", "dynamodb:GetItem"],
        resources: [table.tableArn],
        conditions: {
          "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["CONTENT#*"] },
        },
      }),
    );

    // Jobs stamp UserMetadata {contentId, stage}; matching on stage keeps the
    // dev and prod rules from reacting to each other's jobs (both stages share
    // the one AWS account, and MediaConvert events carry no stack identity).
    const stateChangeRule = new events.Rule(this, "TranscodeStateRule", {
      ruleName: `niltv-${stage}-transcode-state`,
      description: "MediaConvert COMPLETE/ERROR for this stage's transcode jobs",
      eventPattern: {
        source: ["aws.mediaconvert"],
        detailType: ["MediaConvert Job State Change"],
        detail: {
          status: ["COMPLETE", "ERROR"],
          userMetadata: { stage: [stage] },
        },
      },
    });
    stateChangeRule.addTarget(new targets.LambdaFunction(transcodeCompleteFn));

    new CfnOutput(this, "MastersBucketName", { value: this.mastersBucket.bucketName });
    new CfnOutput(this, "OutputBucketName", { value: this.outputBucket.bucketName });
  }
}
