import { join } from "node:path";
import { webOrigins } from "./web-origins";
import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import { HttpJwtAuthorizer, HttpLambdaAuthorizer, HttpLambdaResponseType } from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cloudwatch_actions from "aws-cdk-lib/aws-cloudwatch-actions";
import type * as cognito from "aws-cdk-lib/aws-cognito";
import type * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { DynamoEventSource, SqsDlq } from "aws-cdk-lib/aws-lambda-event-sources";
import type { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as sns from "aws-cdk-lib/aws-sns";
import * as sns_subscriptions from "aws-cdk-lib/aws-sns-subscriptions";
import type { Construct } from "constructs";
import { makeFn } from "./fn";
import { FoundationStack } from "./foundation-stack";
import { partnerDlParams, partnerDlSecretName } from "./partner-stack";

/** Where ops alarms page to (SNS email subscription — confirm once per deploy env). */
const ALERTS_EMAIL = process.env.NILTV_ALERTS_EMAIL ?? "anson@niltv.com";

export interface ApiStackProps extends StackProps {
  stage: string;
  table: dynamodb.ITable;
  userPool: cognito.IUserPool;
  userPoolClient: cognito.IUserPoolClient;
  /** Salt for partner API key hashes (foundation stack) — the partner authorizer hashes with it. */
  partnerKeyPepper: secretsmanager.ISecret;
}

/**
 * API Gateway HTTP API + Lambda handlers (design §4). Public routes are
 * CloudFront-cached via the edge stack; authed routes attach the Cognito JWT
 * authorizer. Every function gets least-privilege table access and an
 * Errors alarm wired to the alerts topic.
 */
export class ApiStack extends Stack {
  public readonly httpApi: apigwv2.HttpApi;
  /**
   * Shared secret injected by CloudFront as the x-origin-verify header and
   * checked by handlers, so the execute-api endpoint can't be used to bypass
   * CloudFront/WAF (design §8, §10).
   */
  public readonly originVerifySecret: secretsmanager.ISecret;
  /**
   * Cognito JWT authorizer for the authed routes (`/v1/me*`, votes, …). In
   * dev the audience also accepts the foundation stack's test client so CLI
   * integration tests (USER_PASSWORD_AUTH) can call the API.
   */
  public readonly jwtAuthorizer: HttpJwtAuthorizer;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);
    const { stage, table, userPool, userPoolClient, partnerKeyPepper } = props;

    // ── Origin lockdown secret (shared with the edge stack) ────────────────
    this.originVerifySecret = new secretsmanager.Secret(this, "OriginVerifySecret", {
      secretName: `niltv-${stage}-origin-verify`,
      description: "Value CloudFront sends as x-origin-verify; handlers reject requests without it",
      generateSecretString: {
        excludePunctuation: true,
        passwordLength: 32,
      },
    });

    // ── Handler factory (design §4.1): one small Lambda per resource group ─
    const apiEnv = {
      TABLE_NAME: table.tableName,
      // CFN dynamic reference — resolved at deploy time, never in the template.
      ORIGIN_VERIFY_SECRET: this.originVerifySecret.secretValue.unsafeUnwrap(),
    };
    const apiFns: Array<{ id: string; name: string; fn: NodejsFunction }> = [];
    const apiFn = (fnId: string, name: string, file: string): NodejsFunction => {
      const fn = makeFn(this, fnId, {
        stage,
        name,
        entry: join(__dirname, "..", "src", "handlers", file),
        env: apiEnv,
      });
      apiFns.push({ id: fnId, name, fn });
      return fn;
    };

    const configFn = apiFn("ConfigFn", "config", "config.ts");
    const homeFn = apiFn("HomeFn", "home", "home.ts");
    const eventsListFn = apiFn("EventsListFn", "events-list", "events-list.ts");
    const eventDetailFn = apiFn("EventDetailFn", "event-detail", "event-detail.ts");
    const channelsFn = apiFn("ChannelsFn", "channels", "channels.ts");
    const contentListFn = apiFn("ContentListFn", "content-list", "content-list.ts");
    const contentDetailFn = apiFn("ContentDetailFn", "content-detail", "content-detail.ts");
    const profileFn = apiFn("ProfileFn", "profile", "profile.ts");
    const profilesListFn = apiFn("ProfilesListFn", "profiles-list", "profiles-list.ts");
    const meFn = apiFn("MeFn", "me", "me.ts");
    const followFn = apiFn("FollowFn", "follow", "follow.ts");
    const likeFn = apiFn("LikeFn", "like", "like.ts");
    const voteFn = apiFn("VoteFn", "vote", "vote.ts");
    const telemetryFn = apiFn("TelemetryFn", "telemetry", "telemetry.ts");
    const pushSettingsFn = apiFn("PushSettingsFn", "push-settings", "push-settings.ts");
    const notifFollowsFn = apiFn("NotifFollowsFn", "notification-follows", "notification-follows.ts");
    const newsletterFn = apiFn("NewsletterFn", "newsletter", "newsletter.ts");
    const newsletterConfirmFn = apiFn("NewsletterConfirmFn", "newsletter-confirm", "newsletter-confirm.ts");
    const deleteMeFn = apiFn("DeleteMeFn", "delete-me", "delete-me.ts");

    // ── Partner content API (/partner/v1, keyed) ───────────────────────────
    // The routes exist in every stage; PARTNER_API_ENABLED decides whether
    // they answer (context `niltv:partnerApi:{stage}`; defaults to on in dev,
    // off in prod). Signing material for download URLs is
    // read at runtime from the SSM parameters the edge stack publishes and
    // the Secrets Manager key scripts/partner-dl-keypair.ts writes.
    const partnerApiEnabled =
      (this.node.tryGetContext(`niltv:partnerApi:${stage}`) as string | undefined) ?? (stage === "dev" ? "true" : "false");
    const partnerDl = partnerDlParams(stage);
    const partnerEnv: Record<string, string> = {
      PARTNER_API_ENABLED: partnerApiEnabled,
      SITE_ORIGIN: stage === "prod" ? "https://niltv.com" : "https://dev.dkdfgvugisb3v.amplifyapp.com",
      PARTNER_DL_DOMAIN_PARAM: partnerDl.domain,
      PARTNER_DL_KEYPAIR_PARAM: partnerDl.keyPairId,
      PARTNER_DL_PRIVATE_KEY_SECRET: partnerDlSecretName(stage),
    };
    const partnerFn = (fnId: string, name: string, file: string, memorySize?: number): NodejsFunction => {
      const fn = makeFn(this, fnId, {
        stage,
        name,
        entry: join(__dirname, "..", "src", "handlers", "partner", file),
        env: apiEnv,
        ...(memorySize ? { memorySize } : {}),
      });
      apiFns.push({ id: fnId, name, fn });
      for (const [key, value] of Object.entries(partnerEnv)) fn.addEnvironment(key, value);
      return fn;
    };
    const partnerMeFn = partnerFn("PartnerMeFn", "partner-me", "me.ts");
    const partnerSeriesFn = partnerFn("PartnerSeriesFn", "partner-series", "series.ts");
    // The list and detail sign URLs (RSA per file); CPU follows memory on Lambda.
    const partnerContentListFn = partnerFn("PartnerContentListFn", "partner-content-list", "content-list.ts", 1024);
    const partnerContentDetailFn = partnerFn("PartnerContentDetailFn", "partner-content-detail", "content-detail.ts", 512);
    const partnerChangesFn = partnerFn("PartnerChangesFn", "partner-changes", "changes.ts");
    const partnerReadFns = [partnerMeFn, partnerSeriesFn, partnerContentListFn, partnerContentDetailFn, partnerChangesFn];
    const partnerAuthorizerFn = makeFn(this, "PartnerAuthorizerFn", {
      stage,
      name: "partner-authorizer",
      entry: join(__dirname, "..", "src", "handlers", "partner", "authorizer.ts"),
      env: {
        TABLE_NAME: table.tableName,
        PARTNER_KEY_PEPPER: partnerKeyPepper.secretValue.unsafeUnwrap(),
      },
    });
    apiFns.push({ id: "PartnerAuthorizerFn", name: "partner-authorizer", fn: partnerAuthorizerFn });

    // ── Playback URL composition (design §6.8) ─────────────────────────────
    // Content rows written by the transcode pipeline store domain-less paths;
    // the content handlers compose absolute URLs from the CloudFront domain,
    // provided per stage via context (the edge stack's distribution domain —
    // context, not a stack reference, to avoid an api→edge dependency cycle).
    const cfDomain = this.node.tryGetContext(`niltv:cfDomain:${stage}`) as string | undefined;
    if (cfDomain) {
      // homeFn included: its rails carry the same composed thumbs as the grids.
      // eventDetailFn/eventsListFn included: event media (intro reels, season
      // showcases) stores bucket paths and composes them the same way.
      for (const fn of [contentListFn, contentDetailFn, profileFn, homeFn, eventDetailFn, eventsListFn, partnerMeFn]) {
        fn.addEnvironment("PLAYBACK_BASE_URL", `https://${cfDomain}`);
      }
      // the newsletter confirm link points back at this API's public edge,
      // and its mark is composed from the same CDN as the Cognito mail
      // (foundation stack, emailLogoBase).
      newsletterFn.addEnvironment("PUBLIC_API_ORIGIN", `https://${cfDomain}`);
      newsletterFn.addEnvironment("EMAIL_LOGO_BASE", `https://${cfDomain}`);
    }
    // double opt-in: confirm emails go out from the DKIM-verified niltv.com
    // identity; the confirm handler bounces visitors back to the site once
    // the token is consumed.
    const siteOrigin = stage === "prod" ? "https://niltv.com" : "https://dev.dkdfgvugisb3v.amplifyapp.com";
    for (const fn of [newsletterFn, newsletterConfirmFn]) {
      fn.addEnvironment("SITE_ORIGIN", siteOrigin);
      fn.addEnvironment("FROM_EMAIL", "no-reply@niltv.com");
    }

    // ── Least-privilege table access per function ──────────────────────────
    // Public composed reads: Query/Get/BatchGet on the table + GSI1 (rails,
    // events list, Watch grid, directory). No GSI2, no writes. (Query on an
    // index authorizes against the index ARN, so it is granted explicitly.)
    const publicReadPolicy = new iam.PolicyStatement({
      actions: ["dynamodb:Query", "dynamodb:GetItem", "dynamodb:BatchGetItem"],
      resources: [table.tableArn, `${table.tableArn}/index/GSI1`],
    });
    // config only ever GetItems the CONFIG row, but shares the read trio for
    // symmetry with the other public reads (still read-only, still no GSI2).
    for (const fn of [
      configFn,
      homeFn,
      eventsListFn,
      eventDetailFn,
      channelsFn,
      contentListFn,
      contentDetailFn,
      profileFn,
      profilesListFn,
    ]) {
      fn.addToRolePolicy(publicReadPolicy);
    }
    // profile and content-list additionally read the creator-attribution
    // index (design §5 GSI2: the athlete's published clips) — profile for its
    // first-dozen Content tab, content-list for the ?athleteId= pager behind
    // the profile screen's infinite grid.
    const creatorIndexPolicy = new iam.PolicyStatement({
      actions: ["dynamodb:Query"],
      resources: [`${table.tableArn}/index/GSI2`],
    });
    profileFn.addToRolePolicy(creatorIndexPolicy);
    contentListFn.addToRolePolicy(creatorIndexPolicy);

    // Partner content API: reads on the partner/series/channel/profile/content
    // partitions plus the syndication index (GSI3), and the signing material.
    // The authorizer only ever reads key and partner rows.
    const partnerReadPolicy = new iam.PolicyStatement({
      actions: ["dynamodb:GetItem", "dynamodb:BatchGetItem"],
      resources: [table.tableArn],
      conditions: {
        "ForAllValues:StringLike": {
          "dynamodb:LeadingKeys": ["PARTNER#*", "SERIES#*", "CHANNEL#*", "ATHLETE#*", "CONTENT#*"],
        },
      },
    });
    const syndicationIndexPolicy = new iam.PolicyStatement({
      actions: ["dynamodb:Query"],
      resources: [`${table.tableArn}/index/GSI3`],
    });
    const partnerSigningPolicies = [
      new iam.PolicyStatement({
        actions: ["ssm:GetParameter"],
        resources: [
          this.formatArn({ service: "ssm", resource: "parameter", resourceName: partnerDl.domain.slice(1) }),
          this.formatArn({ service: "ssm", resource: "parameter", resourceName: partnerDl.keyPairId.slice(1) }),
        ],
      }),
      new iam.PolicyStatement({
        actions: ["secretsmanager:GetSecretValue"],
        resources: [`arn:${this.partition}:secretsmanager:${this.region}:${this.account}:secret:${partnerDlSecretName(stage)}-*`],
      }),
    ];
    for (const fn of partnerReadFns) {
      fn.addToRolePolicy(partnerReadPolicy);
      fn.addToRolePolicy(syndicationIndexPolicy);
      for (const policy of partnerSigningPolicies) fn.addToRolePolicy(policy);
    }
    partnerAuthorizerFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["dynamodb:GetItem"],
        resources: [table.tableArn],
        conditions: {
          "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["PARTNERKEY#*", "PARTNER#*"] },
        },
      }),
    );

    // /v1/me reads its own partition and nothing else.
    meFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["dynamodb:Query"],
        resources: [table.tableArn],
        conditions: {
          "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["USER#*"] },
        },
      }),
    );

    // follow: fact row writes in USER#*, existence check + follower counter
    // in ATHLETE#* — nothing else on the table, nothing on the GSIs.
    followFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["dynamodb:PutItem", "dynamodb:DeleteItem"],
        resources: [table.tableArn],
        conditions: {
          "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["USER#*"] },
        },
      }),
    );
    followFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["dynamodb:GetItem", "dynamodb:UpdateItem"],
        resources: [table.tableArn],
        conditions: {
          "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["ATHLETE#*"] },
        },
      }),
    );

    // like mirrors follow: fact row writes in USER#*, existence check + likes
    // counter in CONTENT#* — nothing else on the table, nothing on the GSIs.
    likeFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["dynamodb:PutItem", "dynamodb:DeleteItem"],
        resources: [table.tableArn],
        conditions: {
          "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["USER#*"] },
        },
      }),
    );
    likeFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["dynamodb:GetItem", "dynamodb:UpdateItem"],
        resources: [table.tableArn],
        conditions: {
          "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["CONTENT#*"] },
        },
      }),
    );

    // vote (design §6.3): the conditional Vote fact row lands in USER#*, the
    // window/entry reads and the counter ADD live in EVENT#* — no GSIs, no
    // deletes (votes are never removed by the API).
    voteFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["dynamodb:PutItem"],
        resources: [table.tableArn],
        conditions: {
          "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["USER#*"] },
        },
      }),
    );
    voteFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["dynamodb:GetItem", "dynamodb:UpdateItem"],
        resources: [table.tableArn],
        conditions: {
          "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["EVENT#*"] },
        },
      }),
    );

    // push-settings: device row upsert + the pushEnabled toggle — USER#* only.
    pushSettingsFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["dynamodb:PutItem", "dynamodb:UpdateItem"],
        resources: [table.tableArn],
        conditions: {
          "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["USER#*"] },
        },
      }),
    );

    // notification-follows: read current NOTIF# rows + batch replace — USER#* only.
    notifFollowsFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["dynamodb:Query", "dynamodb:BatchWriteItem"],
        resources: [table.tableArn],
        conditions: {
          "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["USER#*"] },
        },
      }),
    );

    // newsletter: subscriber upsert + confirm token — SUB#* and NLTOKEN#* only
    // (design §6.7 + double opt-in).
    newsletterFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem"],
        resources: [table.tableArn],
        conditions: {
          "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["SUB#*", "NLTOKEN#*"] },
        },
      }),
    );
    newsletterFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ses:SendEmail", "ses:SendRawEmail"],
        // SESv2 authorises against BOTH the sending identity and the
        // configuration set named on the request (foundation-stack
        // "niltv-transactional"). Without the second ARN every confirm
        // email fails with AccessDenied.
        resources: [
          `arn:aws:ses:${this.region}:${this.account}:identity/niltv.com`,
          `arn:aws:ses:${this.region}:${this.account}:configuration-set/niltv-transactional`,
        ],
      }),
    );
    // newsletter confirm: consume the token, flip the subscriber, retire the token.
    newsletterConfirmFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["dynamodb:GetItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem"],
        resources: [table.tableArn],
        conditions: {
          "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["SUB#*", "NLTOKEN#*"] },
        },
      }),
    );

    // delete-me (design §6.6): full USER#* purge (the anonymized vote copies
    // land under USER#deleted#* — same prefix), newsletter unsubscribe, and
    // the follower/like counter decrements on the counted rows.
    deleteMeFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["dynamodb:Query", "dynamodb:PutItem", "dynamodb:DeleteItem"],
        resources: [table.tableArn],
        conditions: {
          "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["USER#*", "SUB#*"] },
        },
      }),
    );
    deleteMeFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["dynamodb:UpdateItem"],
        resources: [table.tableArn],
        conditions: {
          "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["ATHLETE#*", "CONTENT#*"] },
        },
      }),
    );
    deleteMeFn.addEnvironment("USER_POOL_ID", userPool.userPoolId);
    deleteMeFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["cognito-idp:AdminDeleteUser"],
        resources: [userPool.userPoolArn],
      }),
    );

    // ── Push fanout off the table stream (design §6.4) ─────────────────────
    // Content publish edge → ★-picker audiences → Expo Push. Retries bisect
    // around the failing record; what still fails after 3 attempts lands in
    // the DLQ (alarmed below) instead of blocking the shard.
    const fanoutFn = makeFn(this, "FanoutPushFn", {
      stage,
      name: "fanout-push",
      entry: join(__dirname, "..", "src", "handlers", "fanout-push.ts"),
      env: { TABLE_NAME: table.tableName },
    });
    const fanoutDlq = new sqs.Queue(this, "FanoutDlq", {
      queueName: `niltv-${stage}-fanout-dlq`,
      retentionPeriod: Duration.days(14),
      enforceSSL: true,
    });
    fanoutFn.addEventSource(
      new DynamoEventSource(table, {
        startingPosition: lambda.StartingPosition.LATEST,
        batchSize: 25,
        retryAttempts: 3,
        bisectBatchOnError: true,
        reportBatchItemFailures: true,
        onFailure: new SqsDlq(fanoutDlq),
      }),
    );
    // Audience + channel-name reads, pushEnabled batch-gets and dead-token
    // pruning (design §6.4). Prune deletes are batch writes in USER#*.
    fanoutFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["dynamodb:Query"],
        resources: [`${table.tableArn}/index/GSI1`],
      }),
    );
    fanoutFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["dynamodb:GetItem", "dynamodb:BatchGetItem", "dynamodb:BatchWriteItem"],
        resources: [table.tableArn],
        conditions: {
          "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["USER#*", "CHANNEL#*"] },
        },
      }),
    );

    // ── Telemetry sink (design §11): Lambda → S3 directly, Athena later ────
    // NOTE: direct S3 writes instead of Firehose. At MVP volume they are
    // simpler and cheaper: each batch lands as one gzip NDJSON object
    // under telemetry/yyyy/MM/dd/, which Athena reads the same way. Revisit
    // Firehose only if per-object overhead ever matters.
    const isDev = stage === "dev";
    const analyticsBucket = new s3.Bucket(this, "AnalyticsBucket", {
      bucketName: `niltv-${stage}-analytics-${this.account}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: isDev ? RemovalPolicy.DESTROY : RemovalPolicy.RETAIN,
      autoDeleteObjects: isDev,
    });

    telemetryFn.addEnvironment("ANALYTICS_BUCKET", analyticsBucket.bucketName);
    telemetryFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["s3:PutObject"],
        resources: [analyticsBucket.arnForObjects("telemetry/*")],
      }),
    );

    // ── HTTP API + routes ──────────────────────────────────────────────────
    this.httpApi = new apigwv2.HttpApi(this, "HttpApi", {
      apiName: `niltv-${stage}-api`,
      // CORS for browser clients (the Expo web preview / future web app).
      // Native apps ignore CORS; browsers need ACAO on responses and an
      // OPTIONS preflight answer (managed here by API Gateway, before any
      // Lambda — so origin-verify never sees preflights). `*` is correct and
      // cache-safe for this API: the data is public, auth is a Bearer header
      // (not cookies — no ambient credentials, so no CSRF surface), and a
      // static ACAO can't be cache-poisoned per-origin at CloudFront.
      corsPreflight: {
        // explicit web origins instead of the wildcard
        allowOrigins: webOrigins(stage),
        allowMethods: [
          apigwv2.CorsHttpMethod.GET,
          apigwv2.CorsHttpMethod.POST,
          apigwv2.CorsHttpMethod.PUT,
          apigwv2.CorsHttpMethod.DELETE,
        ],
        allowHeaders: ["authorization", "content-type"],
        maxAge: Duration.days(1),
      },
    });

    // Throttling backstop on the default stage: WAF rate-limits per IP at the
    // edge, but anyone hitting execute-api directly only meets this cap.
    const defaultStage = this.httpApi.defaultStage?.node.defaultChild as apigwv2.CfnStage;
    // Dev keeps a small cap so a runaway load test cannot spend real money.
    // Prod must NOT: 50 rps is roughly 400 app-opens a minute once each
    // screen's handful of reads is counted, which one athlete sharing a voting
    // link would exceed instantly. Prod gets headroom, still well under the
    // 10,000 rps account default so it remains a real backstop.
    defaultStage.defaultRouteSettings =
      stage === "dev"
        ? { throttlingRateLimit: 50, throttlingBurstLimit: 100 }
        : { throttlingRateLimit: 2000, throttlingBurstLimit: 4000 };

    // issuer: https://cognito-idp.us-east-1.amazonaws.com/{poolId} (region pinned in bin/app.ts)
    // Audience: the mobile client, the website's client (niltv.com signs in
    // with it and calls /v1/me*), and, in dev only, the foundation stack's
    // test client (bin/app.ts wires stacks; the clients are discovered off
    // the shared user pool so the wiring stays untouched). Without the web
    // client here every site sign-in gets 401 from /v1/me.
    const foundation = Stack.of(userPool);
    const testClient = foundation instanceof FoundationStack ? foundation.testClient : undefined;
    const webClient = foundation instanceof FoundationStack ? foundation.webClient : undefined;
    const jwtAudience = [userPoolClient.userPoolClientId];
    if (webClient) jwtAudience.push(webClient.userPoolClientId);
    if (testClient) jwtAudience.push(testClient.userPoolClientId);
    this.jwtAuthorizer = new HttpJwtAuthorizer(
      "CognitoJwtAuthorizer",
      `https://cognito-idp.${this.region}.amazonaws.com/${userPool.userPoolId}`,
      { jwtAudience },
    );

    // Public reads (CloudFront-cached via response Cache-Control, design §8).
    this.httpApi.addRoutes({
      path: "/v1/config",
      methods: [apigwv2.HttpMethod.GET],
      integration: new HttpLambdaIntegration("ConfigIntegration", configFn),
    });
    this.httpApi.addRoutes({
      path: "/v1/home",
      methods: [apigwv2.HttpMethod.GET],
      integration: new HttpLambdaIntegration("HomeIntegration", homeFn),
    });
    this.httpApi.addRoutes({
      path: "/v1/events",
      methods: [apigwv2.HttpMethod.GET],
      integration: new HttpLambdaIntegration("EventsListIntegration", eventsListFn),
    });
    this.httpApi.addRoutes({
      path: "/v1/events/{eventId}",
      methods: [apigwv2.HttpMethod.GET],
      integration: new HttpLambdaIntegration("EventDetailIntegration", eventDetailFn),
    });
    this.httpApi.addRoutes({
      path: "/v1/channels",
      methods: [apigwv2.HttpMethod.GET],
      integration: new HttpLambdaIntegration("ChannelsIntegration", channelsFn),
    });
    this.httpApi.addRoutes({
      path: "/v1/content",
      methods: [apigwv2.HttpMethod.GET],
      integration: new HttpLambdaIntegration("ContentListIntegration", contentListFn),
    });
    this.httpApi.addRoutes({
      path: "/v1/content/{contentId}",
      methods: [apigwv2.HttpMethod.GET],
      integration: new HttpLambdaIntegration("ContentDetailIntegration", contentDetailFn),
    });
    this.httpApi.addRoutes({
      path: "/v1/profiles",
      methods: [apigwv2.HttpMethod.GET],
      integration: new HttpLambdaIntegration("ProfilesListIntegration", profilesListFn),
    });
    this.httpApi.addRoutes({
      path: "/v1/profiles/{athleteId}",
      methods: [apigwv2.HttpMethod.GET],
      integration: new HttpLambdaIntegration("ProfileIntegration", profileFn),
    });
    // Telemetry is a public POST (design §4.1: also accepts anonymous) —
    // origin-verify + WAF rate limits are its gate, not a JWT.
    this.httpApi.addRoutes({
      path: "/v1/telemetry",
      methods: [apigwv2.HttpMethod.POST],
      integration: new HttpLambdaIntegration("TelemetryIntegration", telemetryFn),
    });
    // Newsletter is likewise public (design §6.7) — origin-verify + WAF gated.
    this.httpApi.addRoutes({
      path: "/v1/newsletter",
      methods: [apigwv2.HttpMethod.POST],
      integration: new HttpLambdaIntegration("NewsletterIntegration", newsletterFn),
    });
    // The emailed confirm link (double opt-in). GET so a mail client can open it.
    this.httpApi.addRoutes({
      path: "/v1/newsletter/confirm",
      methods: [apigwv2.HttpMethod.GET],
      integration: new HttpLambdaIntegration("NewsletterConfirmIntegration", newsletterConfirmFn),
    });

    // Partner content API routes: keyed by the Lambda authorizer (x-api-key),
    // verdict cached per key for 5 minutes, origin-locked like everything else.
    const partnerAuthorizer = new HttpLambdaAuthorizer("PartnerKeyAuthorizer", partnerAuthorizerFn, {
      responseTypes: [HttpLambdaResponseType.SIMPLE],
      identitySource: ["$request.header.x-api-key"],
      resultsCacheTtl: Duration.minutes(5),
    });
    const partnerRoutes: Array<{ path: string; id: string; fn: NodejsFunction }> = [
      { path: "/partner/v1/me", id: "PartnerMe", fn: partnerMeFn },
      { path: "/partner/v1/series", id: "PartnerSeries", fn: partnerSeriesFn },
      { path: "/partner/v1/channels", id: "PartnerChannels", fn: partnerSeriesFn },
      { path: "/partner/v1/content", id: "PartnerContentList", fn: partnerContentListFn },
      { path: "/partner/v1/content/{id}", id: "PartnerContentDetail", fn: partnerContentDetailFn },
      { path: "/partner/v1/changes", id: "PartnerChanges", fn: partnerChangesFn },
    ];
    for (const route of partnerRoutes) {
      this.httpApi.addRoutes({
        path: route.path,
        methods: [apigwv2.HttpMethod.GET],
        integration: new HttpLambdaIntegration(`${route.id}Integration`, route.fn),
        authorizer: partnerAuthorizer,
      });
    }

    // Authed routes (Cognito JWT — design §4 access tiers).
    this.httpApi.addRoutes({
      path: "/v1/me",
      methods: [apigwv2.HttpMethod.GET],
      integration: new HttpLambdaIntegration("MeIntegration", meFn),
      authorizer: this.jwtAuthorizer,
    });
    this.httpApi.addRoutes({
      path: "/v1/me/follows/{athleteId}",
      methods: [apigwv2.HttpMethod.PUT, apigwv2.HttpMethod.DELETE],
      integration: new HttpLambdaIntegration("FollowIntegration", followFn),
      authorizer: this.jwtAuthorizer,
    });
    this.httpApi.addRoutes({
      path: "/v1/me/likes/{contentId}",
      methods: [apigwv2.HttpMethod.POST, apigwv2.HttpMethod.DELETE],
      integration: new HttpLambdaIntegration("LikeIntegration", likeFn),
      authorizer: this.jwtAuthorizer,
    });
    this.httpApi.addRoutes({
      path: "/v1/events/{eventId}/vote",
      methods: [apigwv2.HttpMethod.POST],
      integration: new HttpLambdaIntegration("VoteIntegration", voteFn),
      authorizer: this.jwtAuthorizer,
    });
    this.httpApi.addRoutes({
      path: "/v1/me/devices",
      methods: [apigwv2.HttpMethod.POST],
      integration: new HttpLambdaIntegration("DevicesIntegration", pushSettingsFn),
      authorizer: this.jwtAuthorizer,
    });
    this.httpApi.addRoutes({
      path: "/v1/me/push",
      methods: [apigwv2.HttpMethod.PUT],
      integration: new HttpLambdaIntegration("PushToggleIntegration", pushSettingsFn),
      authorizer: this.jwtAuthorizer,
    });
    this.httpApi.addRoutes({
      path: "/v1/me/notification-follows",
      methods: [apigwv2.HttpMethod.PUT],
      integration: new HttpLambdaIntegration("NotifFollowsIntegration", notifFollowsFn),
      authorizer: this.jwtAuthorizer,
    });
    this.httpApi.addRoutes({
      path: "/v1/me",
      methods: [apigwv2.HttpMethod.DELETE],
      integration: new HttpLambdaIntegration("DeleteMeIntegration", deleteMeFn),
      authorizer: this.jwtAuthorizer,
    });

    // ── Ops alarms → SNS email (design §10: fail loudly, not silently) ─────
    const alertsTopic = new sns.Topic(this, "AlertsTopic", {
      topicName: `niltv-${stage}-alerts`,
    });
    alertsTopic.addSubscription(new sns_subscriptions.EmailSubscription(ALERTS_EMAIL));
    const alarmAction = new cloudwatch_actions.SnsAction(alertsTopic);

    // Sustained 5xx at the API front door.
    const api5xxAlarm = new cloudwatch.Alarm(this, "Api5xxAlarm", {
      alarmName: `niltv-${stage}-api-5xx`,
      alarmDescription: "HTTP API served ≥5 5xx responses in 5 minutes",
      metric: this.httpApi.metricServerError({ period: Duration.minutes(5), statistic: "sum" }),
      threshold: 5,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    api5xxAlarm.addAlarmAction(alarmAction);

    // Any handler error pages — Lambda Errors is the earliest signal (a
    // thrown handler shows up here even when API Gateway masks it as one 5xx).
    for (const { id: fnId, name, fn } of apiFns) {
      const errorsAlarm = new cloudwatch.Alarm(this, `${fnId}ErrorsAlarm`, {
        alarmName: `niltv-${stage}-${name}-errors`,
        alarmDescription: `niltv-${stage}-${name} reported ≥1 invocation error in 5 minutes`,
        metric: fn.metricErrors({ period: Duration.minutes(5), statistic: "sum" }),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
      errorsAlarm.addAlarmAction(alarmAction);
    }

    // Fanout is not an API fn (no route → not in apiFns) — same error alarm,
    // plus a DLQ-depth alarm: a message here means a push a user never got.
    const fanoutErrorsAlarm = new cloudwatch.Alarm(this, "FanoutPushErrorsAlarm", {
      alarmName: `niltv-${stage}-fanout-push-errors`,
      alarmDescription: `niltv-${stage}-fanout-push reported ≥1 invocation error in 5 minutes`,
      metric: fanoutFn.metricErrors({ period: Duration.minutes(5), statistic: "sum" }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    fanoutErrorsAlarm.addAlarmAction(alarmAction);
    const fanoutDlqAlarm = new cloudwatch.Alarm(this, "FanoutDlqAlarm", {
      alarmName: `niltv-${stage}-fanout-dlq`,
      alarmDescription: "fanout-push stream records exhausted retries and landed in the DLQ",
      metric: fanoutDlq.metricApproximateNumberOfMessagesVisible({
        period: Duration.minutes(5),
        statistic: "max",
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    fanoutDlqAlarm.addAlarmAction(alarmAction);

    new CfnOutput(this, "ApiUrl", { value: this.httpApi.apiEndpoint });
    new CfnOutput(this, "AlertsTopicArn", { value: alertsTopic.topicArn });
    new CfnOutput(this, "AnalyticsBucketName", { value: analyticsBucket.bucketName });
  }
}
