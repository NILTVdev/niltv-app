import { join } from "node:path";
import { CfnOutput, Duration, Stack, type StackProps } from "aws-cdk-lib";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import { HttpJwtAuthorizer } from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import type * as cognito from "aws-cdk-lib/aws-cognito";
import type * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import type { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import type * as s3 from "aws-cdk-lib/aws-s3";
import type * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import type { Construct } from "constructs";
import { makeFn } from "./fn";

export interface AdminStackProps extends StackProps {
  stage: string;
  table: dynamodb.ITable;
  /** Media stack's masters bucket — presigned staff uploads land here (§6.8). */
  mastersBucket: s3.IBucket;
  userPool: cognito.IUserPool;
  /** Cognito app client ids the JWT authorizer accepts (mobile + dev test client). */
  audienceClientIds: string[];
  /** Salt for partner API key hashes (foundation stack) — key issue/rotate hash with it. */
  partnerKeyPepper: secretsmanager.ISecret;
}

/**
 * Staff admin API (design §4.1 admin tier + §6.8 publish gate): its OWN HTTP
 * API, deliberately NOT behind CloudFront — admin traffic is tiny,
 * uncacheable, and dashboard-only, so it goes direct to execute-api and needs
 * no origin-verify secret. Two authorization layers, both fail-closed:
 *
 *   1. Cognito JWT authorizer on EVERY route (defaultAuthorizer — a route
 *      cannot be added here without inheriting it).
 *   2. `staff` group check inside every handler (handlers/admin/authz.ts) —
 *      the authorizer proves a valid pool token, membership proves staff.
 */
export class AdminStack extends Stack {
  public readonly httpApi: apigwv2.HttpApi;

  constructor(scope: Construct, id: string, props: AdminStackProps) {
    super(scope, id, props);
    const { stage, table, mastersBucket, userPool, audienceClientIds, partnerKeyPepper } = props;

    // ── JWT authorizer (Cognito pool issuer; region pinned in bin/app.ts) ──
    const jwtAuthorizer = new HttpJwtAuthorizer(
      "AdminJwtAuthorizer",
      `https://cognito-idp.${this.region}.amazonaws.com/${userPool.userPoolId}`,
      { jwtAudience: audienceClientIds },
    );

    // ── HTTP API — CORS handled at the gateway (dashboard is a browser SPA) ─
    this.httpApi = new apigwv2.HttpApi(this, "HttpApi", {
      apiName: `niltv-${stage}-admin`,
      // No unauthenticated admin routes: every addRoutes below inherits this.
      defaultAuthorizer: jwtAuthorizer,
      corsPreflight: {
        // TODO: add the hosted admin dashboard origin here when it exists
        // (until then only the local Vite dev server may call from a browser).
        allowOrigins: ["http://localhost:5180"],
        allowMethods: [
          apigwv2.CorsHttpMethod.GET,
          apigwv2.CorsHttpMethod.POST,
          apigwv2.CorsHttpMethod.PATCH,
          apigwv2.CorsHttpMethod.DELETE,
          apigwv2.CorsHttpMethod.OPTIONS,
        ],
        allowHeaders: ["authorization", "content-type"],
        maxAge: Duration.hours(1),
      },
    });

    // Throttling backstop: admin is a handful of humans — anything beyond
    // this is a stolen token or a runaway script.
    const defaultStage = this.httpApi.defaultStage?.node.defaultChild as apigwv2.CfnStage;
    defaultStage.defaultRouteSettings = {
      throttlingRateLimit: 20,
      throttlingBurstLimit: 40,
    };

    // ── Handler factory (per-fn LogGroups via makeFn) ──────────────────────
    const adminFn = (fnId: string, name: string, file: string): NodejsFunction =>
      makeFn(this, fnId, {
        stage,
        name,
        entry: join(__dirname, "..", "src", "handlers", "admin", file),
        env: { TABLE_NAME: table.tableName },
      });

    const contentListFn = adminFn("ContentListFn", "admin-content-list", "content-list.ts");
    const contentUpsertFn = adminFn("ContentUpsertFn", "admin-content-upsert", "content-upsert.ts");
    const uploadUrlFn = adminFn("UploadUrlFn", "admin-upload-url", "upload-url.ts");
    const contentStatusFn = adminFn("ContentStatusFn", "admin-content-status", "content-status.ts");
    const publishFn = adminFn("PublishFn", "admin-publish", "publish.ts");
    const profileListFn = adminFn("ProfileListFn", "admin-profile-list", "profile-list.ts");
    const profileUpsertFn = adminFn("ProfileUpsertFn", "admin-profile-upsert", "profile-upsert.ts");
    const channelListFn = adminFn("ChannelListFn", "admin-channel-list", "channel-list.ts");
    const eventListFn = adminFn("EventListFn", "admin-event-list", "event-list.ts");
    const eventDetailFn = adminFn("EventDetailFn", "admin-event-detail", "event-detail.ts");
    const eventUpsertFn = adminFn("EventUpsertFn", "admin-event-upsert", "event-upsert.ts");
    const entriesFn = adminFn("EntriesFn", "admin-entries", "entries.ts");
    const eventStatusFn = adminFn("EventStatusFn", "admin-event-status", "event-status.ts");
    const eventAuditFn = adminFn("EventAuditFn", "admin-event-audit", "event-audit.ts");
    const newsletterListFn = adminFn("NewsletterListFn", "admin-newsletter-list", "newsletter-list.ts");
    // Partner content API: series, partners, keys, withdrawal. Key material
    // is hashed with the foundation pepper.
    const seriesFn = adminFn("SeriesFn", "admin-series", "series-upsert.ts");
    const partnerListFn = adminFn("PartnerListFn", "admin-partner-list", "partner-list.ts");
    const partnerUpsertFn = adminFn("PartnerUpsertFn", "admin-partner-upsert", "partner-upsert.ts");
    const partnerKeyFn = adminFn("PartnerKeyFn", "admin-partner-key", "partner-key.ts");
    const contentWithdrawFn = adminFn("ContentWithdrawFn", "admin-content-withdraw", "content-withdraw.ts");
    for (const fn of [partnerUpsertFn, partnerKeyFn]) {
      fn.addEnvironment("STAGE", stage);
      fn.addEnvironment("PARTNER_KEY_PEPPER", partnerKeyPepper.secretValue.unsafeUnwrap());
    }

    uploadUrlFn.addEnvironment("MASTERS_BUCKET", mastersBucket.bucketName);

    // ── Event lifecycle (design §6.5) ──────────────────────────────────────
    // The transition Lambda is NOT an HTTP handler: EventBridge Scheduler
    // one-shots (created by event-upsert) invoke it at startsAt/endsAt; the
    // manual status override imports the same module in-process.
    const transitionFn = makeFn(this, "EventTransitionFn", {
      stage,
      name: "event-transition",
      entry: join(__dirname, "..", "src", "handlers", "event-transition.ts"),
      env: { TABLE_NAME: table.tableName },
    });

    // CloudFront invalidation on transition (§6.5). Distribution id comes via
    // context — same pattern as the api stack's cfDomain — to avoid an
    // admin→edge stack dependency; unset (first deploy) skips invalidation.
    const cfDistributionId = this.node.tryGetContext(`niltv:cfDistributionId:${stage}`) as
      | string
      | undefined;
    if (cfDistributionId) {
      const invalidationPolicy = new iam.PolicyStatement({
        actions: ["cloudfront:CreateInvalidation"],
        resources: [`arn:aws:cloudfront::${this.account}:distribution/${cfDistributionId}`],
      });
      for (const fn of [transitionFn, eventStatusFn]) {
        fn.addEnvironment("DISTRIBUTION_ID", cfDistributionId);
        fn.addToRolePolicy(invalidationPolicy);
      }
    }

    // Role EventBridge Scheduler assumes to invoke the transition Lambda.
    const schedulerRole = new iam.Role(this, "SchedulerRole", {
      roleName: `niltv-${stage}-event-scheduler`,
      assumedBy: new iam.ServicePrincipal("scheduler.amazonaws.com"),
    });
    transitionFn.grantInvoke(schedulerRole);

    // event-upsert owns the one-shots: CRUD on its own schedule names only,
    // plus PassRole restricted to Scheduler handing off the invoke role.
    eventUpsertFn.addEnvironment("SCHEDULE_PREFIX", `niltv-${stage}`);
    eventUpsertFn.addEnvironment("TRANSITION_FN_ARN", transitionFn.functionArn);
    eventUpsertFn.addEnvironment("SCHEDULER_ROLE_ARN", schedulerRole.roleArn);
    eventUpsertFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["scheduler:CreateSchedule", "scheduler:UpdateSchedule", "scheduler:DeleteSchedule"],
        resources: [
          `arn:aws:scheduler:${this.region}:${this.account}:schedule/default/niltv-${stage}-ev-*`,
        ],
      }),
    );
    eventUpsertFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["iam:PassRole"],
        resources: [schedulerRole.roleArn],
        conditions: { StringEquals: { "iam:PassedToService": "scheduler.amazonaws.com" } },
      }),
    );

    // ── Least-privilege IAM per function ───────────────────────────────────
    // content-list Scans the whole table (LeadingKeys cannot scope a Scan) —
    // the action list, not the resource, is the privilege boundary here.
    contentListFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["dynamodb:Scan"],
        resources: [table.tableArn],
      }),
    );

    // Writers/readers scoped to their partition key prefix.
    const keyScopedPolicy = (actions: string[], leadingKeys: string[]): iam.PolicyStatement =>
      new iam.PolicyStatement({
        actions,
        resources: [table.tableArn],
        conditions: {
          "ForAllValues:StringLike": { "dynamodb:LeadingKeys": leadingKeys },
        },
      });

    // Upsert reads the row first (override recording), so it needs GetItem.
    // Without it every admin tag is a 500.
    contentUpsertFn.addToRolePolicy(
      keyScopedPolicy(["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem"], ["CONTENT#*"]),
    );
    contentStatusFn.addToRolePolicy(keyScopedPolicy(["dynamodb:GetItem"], ["CONTENT#*"]));
    // publish: read the row for GSI keys/diagnosis + the conditional update.
    publishFn.addToRolePolicy(
      keyScopedPolicy(["dynamodb:GetItem", "dynamodb:UpdateItem"], ["CONTENT#*"]),
    );
    profileUpsertFn.addToRolePolicy(
      keyScopedPolicy(["dynamodb:GetItem", "dynamodb:PutItem"], ["ATHLETE#*"]),
    );
    channelListFn.addToRolePolicy(keyScopedPolicy(["dynamodb:BatchGetItem"], ["CHANNEL#*"]));

    // Event handlers: everything they touch lives under EVENT#* (entries ride
    // in the event partition) except the athlete existence check on entry
    // upsert. Query-on-table (the entry/vote reads) authorizes against the
    // table ARN with the same LeadingKeys scoping.
    const gsi1QueryPolicy = new iam.PolicyStatement({
      actions: ["dynamodb:Query"],
      resources: [`${table.tableArn}/index/GSI1`],
    });
    eventListFn.addToRolePolicy(gsi1QueryPolicy);
    eventDetailFn.addToRolePolicy(
      keyScopedPolicy(["dynamodb:GetItem", "dynamodb:Query"], ["EVENT#*"]),
    );
    eventUpsertFn.addToRolePolicy(
      keyScopedPolicy(["dynamodb:GetItem", "dynamodb:PutItem"], ["EVENT#*"]),
    );
    entriesFn.addToRolePolicy(
      keyScopedPolicy(
        ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem"],
        ["EVENT#*"],
      ),
    );
    entriesFn.addToRolePolicy(keyScopedPolicy(["dynamodb:GetItem"], ["ATHLETE#*"]));
    // status override + scheduled transition run the same module: event read,
    // entry query for the recap snapshot, the guarded status update.
    const transitionTablePolicy = keyScopedPolicy(
      ["dynamodb:GetItem", "dynamodb:Query", "dynamodb:UpdateItem"],
      ["EVENT#*"],
    );
    eventStatusFn.addToRolePolicy(transitionTablePolicy);
    transitionFn.addToRolePolicy(transitionTablePolicy);
    // Lifecycle pushes (design §7): both transition paths (scheduled + manual
    // override) resolve audiences off GSI1 (DEVICES#ALL, voter mirrors),
    // batch-get pushEnabled flags and batch-delete dead tokens (USER#*).
    const transitionPushPolicies = [
      gsi1QueryPolicy,
      keyScopedPolicy(["dynamodb:BatchGetItem", "dynamodb:BatchWriteItem"], ["USER#*"]),
    ];
    for (const policy of transitionPushPolicies) {
      eventStatusFn.addToRolePolicy(policy);
      transitionFn.addToRolePolicy(policy);
    }
    eventAuditFn.addToRolePolicy(keyScopedPolicy(["dynamodb:Query"], ["EVENT#*"]));
    eventAuditFn.addToRolePolicy(gsi1QueryPolicy);
    // Newsletter export reads the SUBS#ALL GSI partition only.
    newsletterListFn.addToRolePolicy(gsi1QueryPolicy);

    // profile-list queries the GSI — Query on an index authorizes against the
    // index ARN (same pattern as the api stack's public reads).
    profileListFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["dynamodb:Query"],
        resources: [`${table.tableArn}/index/GSI1`],
      }),
    );

    // Partner content API. Tagging, publish and withdraw all re-stamp the
    // syndication index, which reads the series row for inherited rights.
    contentUpsertFn.addToRolePolicy(keyScopedPolicy(["dynamodb:GetItem"], ["SERIES#*"]));
    publishFn.addToRolePolicy(keyScopedPolicy(["dynamodb:GetItem"], ["SERIES#*"]));
    contentWithdrawFn.addToRolePolicy(
      keyScopedPolicy(["dynamodb:GetItem", "dynamodb:UpdateItem"], ["CONTENT#*"]),
    );
    contentWithdrawFn.addToRolePolicy(keyScopedPolicy(["dynamodb:GetItem"], ["SERIES#*"]));
    seriesFn.addToRolePolicy(keyScopedPolicy(["dynamodb:GetItem", "dynamodb:PutItem"], ["SERIES#*"]));
    seriesFn.addToRolePolicy(gsi1QueryPolicy);
    partnerListFn.addToRolePolicy(gsi1QueryPolicy);
    // Create is a transaction over the partner row and its key row.
    partnerUpsertFn.addToRolePolicy(
      keyScopedPolicy(["dynamodb:GetItem", "dynamodb:PutItem"], ["PARTNER#*", "PARTNERKEY#*"]),
    );
    partnerKeyFn.addToRolePolicy(
      keyScopedPolicy(["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem"], ["PARTNER#*", "PARTNERKEY#*"]),
    );

    // upload-url: presigning is pure crypto (no S3 call), but the SIGNED URL
    // executes with THIS role at upload time — so the role itself needs
    // s3:PutObject on the masters prefix, and nothing else on the bucket.
    uploadUrlFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["s3:PutObject"],
        resources: [mastersBucket.arnForObjects("masters/*")],
      }),
    );

    // ── Routes (all inherit the default JWT authorizer) ────────────────────
    const routes: Array<{ path: string; methods: apigwv2.HttpMethod[]; id: string; fn: NodejsFunction }> = [
      { path: "/admin/content", methods: [apigwv2.HttpMethod.GET], id: "ContentList", fn: contentListFn },
      { path: "/admin/content", methods: [apigwv2.HttpMethod.POST], id: "ContentUpsert", fn: contentUpsertFn },
      { path: "/admin/content/{id}/upload-url", methods: [apigwv2.HttpMethod.POST], id: "UploadUrl", fn: uploadUrlFn },
      { path: "/admin/content/{id}/status", methods: [apigwv2.HttpMethod.GET], id: "ContentStatus", fn: contentStatusFn },
      { path: "/admin/content/{id}/publish", methods: [apigwv2.HttpMethod.POST], id: "Publish", fn: publishFn },
      { path: "/admin/content/{id}/unpublish", methods: [apigwv2.HttpMethod.POST], id: "Unpublish", fn: publishFn },
      { path: "/admin/profiles", methods: [apigwv2.HttpMethod.GET], id: "ProfileList", fn: profileListFn },
      { path: "/admin/profiles", methods: [apigwv2.HttpMethod.POST], id: "ProfileUpsert", fn: profileUpsertFn },
      { path: "/admin/channels", methods: [apigwv2.HttpMethod.GET], id: "ChannelList", fn: channelListFn },
      { path: "/admin/events", methods: [apigwv2.HttpMethod.GET], id: "EventList", fn: eventListFn },
      { path: "/admin/events", methods: [apigwv2.HttpMethod.POST], id: "EventUpsert", fn: eventUpsertFn },
      { path: "/admin/events/{id}", methods: [apigwv2.HttpMethod.GET], id: "EventDetail", fn: eventDetailFn },
      { path: "/admin/events/{id}/status", methods: [apigwv2.HttpMethod.POST], id: "EventStatus", fn: eventStatusFn },
      { path: "/admin/events/{id}/audit", methods: [apigwv2.HttpMethod.GET], id: "EventAudit", fn: eventAuditFn },
      { path: "/admin/events/{id}/entries", methods: [apigwv2.HttpMethod.POST], id: "EntryUpsert", fn: entriesFn },
      { path: "/admin/events/{id}/entries/{entryId}", methods: [apigwv2.HttpMethod.DELETE], id: "EntryDelete", fn: entriesFn },
      { path: "/admin/newsletter", methods: [apigwv2.HttpMethod.GET], id: "NewsletterList", fn: newsletterListFn },
      // Partner content API
      { path: "/admin/series", methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST], id: "Series", fn: seriesFn },
      { path: "/admin/partners", methods: [apigwv2.HttpMethod.GET], id: "PartnerList", fn: partnerListFn },
      { path: "/admin/partners", methods: [apigwv2.HttpMethod.POST], id: "PartnerUpsert", fn: partnerUpsertFn },
      { path: "/admin/partners/{id}/rotate-key", methods: [apigwv2.HttpMethod.POST], id: "PartnerRotateKey", fn: partnerKeyFn },
      { path: "/admin/partners/{id}/revoke-key", methods: [apigwv2.HttpMethod.POST], id: "PartnerRevokeKey", fn: partnerKeyFn },
      { path: "/admin/content/{id}/withdraw", methods: [apigwv2.HttpMethod.POST], id: "ContentWithdraw", fn: contentWithdrawFn },
      { path: "/admin/content/{id}/restore", methods: [apigwv2.HttpMethod.POST], id: "ContentRestore", fn: contentWithdrawFn },
    ];
    for (const route of routes) {
      this.httpApi.addRoutes({
        path: route.path,
        methods: route.methods,
        integration: new HttpLambdaIntegration(`${route.id}Integration`, route.fn),
      });
    }

    new CfnOutput(this, "AdminApiUrl", { value: this.httpApi.apiEndpoint });
  }
}
