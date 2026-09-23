#!/usr/bin/env node
/**
 * NILTV CDK app — seven stacks per stage (design §2, §4.1, §6.8):
 *
 *   niltv-{stage}-foundation   DynamoDB single table + Cognito user pool
 *   niltv-{stage}-api          API Gateway HTTP API + Lambda handlers (+ /partner/v1)
 *   niltv-{stage}-media        Video ingest: masters/HLS buckets + MediaConvert
 *   niltv-{stage}-edge         CloudFront + WAF in front of the API + /video/* + partner downloads
 *   niltv-{stage}-admin        Staff admin HTTP API (direct, not edge-fronted)
 *   niltv-{stage}-ingest       Social ingest bridge (scheduled)
 *   niltv-{stage}-partner      Partner content API jobs: feeds, lifecycle events, webhooks
 *
 * Stage comes from CDK context (`cdk synth -c stage=dev`). Only the region is
 * pinned — no account id — so `cdk synth` works without AWS credentials (CI).
 */
import { App } from "aws-cdk-lib";
import { AdminStack } from "../lib/admin-stack";
import { ApiStack } from "../lib/api-stack";
import { EdgeStack } from "../lib/edge-stack";
import { FoundationStack } from "../lib/foundation-stack";
import { IngestStack } from "../lib/ingest-stack";
import { MediaStack } from "../lib/media-stack";
import { PartnerStack } from "../lib/partner-stack";

const app = new App();
const stage: string = app.node.tryGetContext("stage") ?? "dev";
const env = { region: "us-east-1" };

const foundation = new FoundationStack(app, `niltv-${stage}-foundation`, {
  stage,
  env,
});

const api = new ApiStack(app, `niltv-${stage}-api`, {
  stage,
  env,
  table: foundation.table,
  userPool: foundation.userPool,
  userPoolClient: foundation.userPoolClient,
  partnerKeyPepper: foundation.partnerKeyPepper,
});

const media = new MediaStack(app, `niltv-${stage}-media`, {
  stage,
  env,
  table: foundation.table,
});

new EdgeStack(app, `niltv-${stage}-edge`, {
  stage,
  env,
  httpApi: api.httpApi,
  originVerifySecret: api.originVerifySecret,
  videoBucket: media.outputBucket,
  mastersBucket: media.mastersBucket,
});

// Staff admin API (design §4.1 admin tier). The JWT authorizer accepts the
// mobile client and — in dev only, where the foundation creates it — the CLI
// test client, so integration tests can mint admin-capable tokens.
const audienceClientIds = [foundation.userPoolClient.userPoolClientId];
if (foundation.testClient) {
  audienceClientIds.push(foundation.testClient.userPoolClientId);
}

new AdminStack(app, `niltv-${stage}-admin`, {
  stage,
  env,
  table: foundation.table,
  mastersBucket: media.mastersBucket,
  userPool: foundation.userPool,
  audienceClientIds,
  partnerKeyPepper: foundation.partnerKeyPepper,
});

// Social ingest bridge (dashboard → app) — the primary content path:
// scheduled direct-publish of collected IG posts (mp4 + poster via
// CloudFront; the MediaConvert pipeline stays for staff uploads only).
new IngestStack(app, `niltv-${stage}-ingest`, {
  stage,
  env,
  table: foundation.table,
  outputBucket: media.outputBucket,
  mastersBucket: media.mastersBucket,
});

// Partner content API — the asynchronous half (feed builds, lifecycle events
// off the table stream, signed webhook delivery). The request path is in the
// api stack; the download distribution is in the edge stack.
new PartnerStack(app, `niltv-${stage}-partner`, {
  stage,
  env,
  table: foundation.table,
  outputBucket: media.outputBucket,
});
