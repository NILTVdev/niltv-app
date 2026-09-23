import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Annotations, CfnOutput, Duration, Fn, Stack, type StackProps } from "aws-cdk-lib";
import type * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import { HttpOrigin, S3BucketOrigin } from "aws-cdk-lib/aws-cloudfront-origins";
import * as s3 from "aws-cdk-lib/aws-s3";
import type * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as ssm from "aws-cdk-lib/aws-ssm";
import * as wafv2 from "aws-cdk-lib/aws-wafv2";
import type { Construct } from "constructs";
import { webOrigins } from "./web-origins";

export interface EdgeStackProps extends StackProps {
  stage: string;
  httpApi: apigwv2.HttpApi;
  /** Shared secret CloudFront forwards as x-origin-verify (origin lockdown). */
  originVerifySecret: secretsmanager.ISecret;
  /** HLS output bucket (media stack) served under /video/* via OAC. */
  videoBucket: s3.IBucket;
  /** Masters bucket (media stack): the partner download distribution serves /masters/* and /originals/* from it. */
  mastersBucket: s3.IBucket;
}

/**
 * CloudFront + WAF in front of the HTTP API (design §2, §8). Public GETs are
 * cached at the edge (short TTLs); everything else passes through uncached.
 * WAFv2 with scope CLOUDFRONT must live in us-east-1 — this app is pinned there.
 */
export class EdgeStack extends Stack {
  public readonly distribution: cloudfront.Distribution;

  constructor(scope: Construct, id: string, props: EdgeStackProps) {
    super(scope, id, props);
    const { stage, httpApi, originVerifySecret, videoBucket, mastersBucket } = props;

    // ── WAF: AWS managed common rules + per-IP rate limit (design §10) ─────
    // Deliberate: WAF runs in dev too (~$7/mo/stage) so dev exercises the
    // exact same edge path as prod.
    const webAcl = new wafv2.CfnWebACL(this, "WebAcl", {
      name: `niltv-${stage}-edge`,
      scope: "CLOUDFRONT",
      defaultAction: { allow: {} },
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: `niltv-${stage}-edge`,
        sampledRequestsEnabled: true,
      },
      rules: [
        {
          name: "AWSManagedRulesCommonRuleSet",
          priority: 0,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: {
              vendorName: "AWS",
              name: "AWSManagedRulesCommonRuleSet",
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: `niltv-${stage}-common-rules`,
            sampledRequestsEnabled: true,
          },
        },
        // Abuse-sensitive writes get their own, much tighter per-IP budgets
        // (design §10 hardening): a legitimate user votes once per event and
        // subscribes once — triple digits per 5 minutes is only ever a bot.
        {
          name: "RateLimitVote",
          priority: 1,
          action: { block: {} },
          statement: {
            rateBasedStatement: {
              // 1000 per 5 min, not 100. This rule is defence-in-depth only —
              // the real one-vote-per-account guarantee is the conditional
              // DynamoDB write, which accepts exactly one vote per user under
              // concurrent retries. At 100 the rule punished shared IPs
              // instead: a campus behind one NAT would see its 101st voter
              // blocked while the database was perfectly capable of judging
              // every one of them correctly.
              limit: 1000,
              aggregateKeyType: "IP",
              scopeDownStatement: {
                byteMatchStatement: {
                  searchString: "/vote",
                  fieldToMatch: { uriPath: {} },
                  positionalConstraint: "ENDS_WITH",
                  textTransformations: [{ priority: 0, type: "NONE" }],
                },
              },
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: `niltv-${stage}-rate-vote`,
            sampledRequestsEnabled: true,
          },
        },
        {
          name: "RateLimitNewsletter",
          priority: 2,
          action: { block: {} },
          statement: {
            rateBasedStatement: {
              limit: 50,
              aggregateKeyType: "IP",
              scopeDownStatement: {
                byteMatchStatement: {
                  searchString: "/v1/newsletter",
                  fieldToMatch: { uriPath: {} },
                  positionalConstraint: "EXACTLY",
                  textTransformations: [{ priority: 0, type: "NONE" }],
                },
              },
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: `niltv-${stage}-rate-newsletter`,
            sampledRequestsEnabled: true,
          },
        },
        // Telemetry is anonymous and lands in S3: with the per-event byte cap
        // in the contract this bounds what one host can write. 600/5-min keeps
        // a campus NAT (250 users, a batch a minute) clear while stopping a
        // single-host flood.
        {
          name: "RateLimitTelemetry",
          priority: 5,
          action: { block: {} },
          statement: {
            rateBasedStatement: {
              limit: 600,
              aggregateKeyType: "IP",
              scopeDownStatement: {
                byteMatchStatement: {
                  searchString: "/v1/telemetry",
                  fieldToMatch: { uriPath: {} },
                  positionalConstraint: "EXACTLY",
                  textTransformations: [{ priority: 0, type: "NONE" }],
                },
              },
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: `niltv-${stage}-rate-telemetry`,
            sampledRequestsEnabled: true,
          },
        },
        // Partner content API (keyed, server-to-server): a poller that
        // misbehaves is cut per IP well before it can dent the origin. The
        // per-key quota is the authorizer's job; this is the blunt backstop.
        {
          name: "RateLimitPartnerApi",
          priority: 6,
          action: { block: {} },
          statement: {
            rateBasedStatement: {
              limit: 3000,
              aggregateKeyType: "IP",
              scopeDownStatement: {
                byteMatchStatement: {
                  searchString: "/partner/",
                  fieldToMatch: { uriPath: {} },
                  positionalConstraint: "STARTS_WITH",
                  textTransformations: [{ priority: 0, type: "NONE" }],
                },
              },
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: `niltv-${stage}-rate-partner`,
            sampledRequestsEnabled: true,
          },
        },
        // The general per-IP ceiling, split by what the request costs.
        //
        // One undifferentiated 2000/5-min rule covering EVERY request including
        // media is far too tight: a real session issues ~181 CloudFront
        // requests per 5-minute window (~38 API, ~143 media), so roughly ELEVEN
        // concurrent users behind one NAT would exhaust the budget. The failure
        // mode is total, not graceful: once WAF engages it returns 403 for
        // every request for the rest of the window. Every student on a campus
        // WiFi shares one public IP.
        //
        // Limits below carry ~250 concurrent users per IP on each class, which
        // covers a campus while still stopping a genuine single-host flood.
        {
          name: "RateLimitApiPerIp",
          priority: 3,
          action: { block: {} },
          statement: {
            rateBasedStatement: {
              limit: 10000,
              aggregateKeyType: "IP",
              scopeDownStatement: {
                byteMatchStatement: {
                  searchString: "/v1/",
                  fieldToMatch: { uriPath: {} },
                  positionalConstraint: "STARTS_WITH",
                  textTransformations: [{ priority: 0, type: "NONE" }],
                },
              },
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: `niltv-${stage}-rate-limit-api`,
            sampledRequestsEnabled: true,
          },
        },
        {
          name: "RateLimitMediaPerIp",
          priority: 4,
          action: { block: {} },
          statement: {
            // Media is the bulk of the traffic and the cheapest to serve (it
            // is a CloudFront cache hit), but it is also what egress is billed
            // on, so it keeps its own generous ceiling rather than none.
            rateBasedStatement: {
              limit: 40000,
              aggregateKeyType: "IP",
              scopeDownStatement: {
                byteMatchStatement: {
                  searchString: "/video/",
                  fieldToMatch: { uriPath: {} },
                  positionalConstraint: "STARTS_WITH",
                  textTransformations: [{ priority: 0, type: "NONE" }],
                },
              },
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: `niltv-${stage}-rate-limit-media`,
            sampledRequestsEnabled: true,
          },
        },
      ],
    });

    // Origin host from the API endpoint URL (https://{id}.execute-api.{region}.amazonaws.com).
    const apiHost = Fn.select(2, Fn.split("/", httpApi.apiEndpoint));
    const apiOrigin = new HttpOrigin(apiHost, {
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
      customHeaders: {
        // CFN dynamic reference ({{resolve:secretsmanager:…}}) — the secret
        // value resolves at deploy time and never appears in the template.
        // Handlers reject requests missing it, closing the execute-api bypass.
        "x-origin-verify": originVerifySecret.secretValue.unsafeUnwrap(),
      },
    });

    // ── /video/* origin: HLS bucket via Origin Access Control (design §6.8) ─
    // The bucket is re-imported by name so the OAC origin does NOT try to
    // write the bucket policy from this stack: with the owned cross-stack
    // Bucket, the origins module would add a policy statement (materialized in
    // the media stack) referencing this distribution's id — a cyclic
    // cross-stack dependency, since this stack already references the bucket's
    // domain name. The matching read statement (cloudfront.amazonaws.com,
    // scoped to this account's distributions) lives on the bucket in the media
    // stack instead.
    const videoOriginBucket = s3.Bucket.fromBucketAttributes(this, "VideoOriginBucket", {
      bucketName: videoBucket.bucketName,
      region: this.region,
    });
    const videoOac = new cloudfront.S3OriginAccessControl(this, "VideoOac", {
      originAccessControlName: `niltv-${stage}-video`,
      description: "CloudFront read access to the NILTV HLS output bucket",
    });
    const videoOrigin = S3BucketOrigin.withOriginAccessControl(videoOriginBucket, {
      originAccessControl: videoOac,
    });

    // Short public cache for /v1/config — the handler also sends max-age=60 (§8).
    const configCachePolicy = new cloudfront.CachePolicy(this, "ConfigCachePolicy", {
      cachePolicyName: `niltv-${stage}-config`,
      comment: "Short public cache for GET /v1/config",
      minTtl: Duration.seconds(0),
      defaultTtl: Duration.seconds(60),
      maxTtl: Duration.seconds(300),
      cookieBehavior: cloudfront.CacheCookieBehavior.none(),
      headerBehavior: cloudfront.CacheHeaderBehavior.none(),
      queryStringBehavior: cloudfront.CacheQueryStringBehavior.none(),
      enableAcceptEncodingGzip: true,
      enableAcceptEncodingBrotli: true,
    });

    // Public read cache for the catalogue endpoints. Every handler behind these
    // paths (home, content, events, channels, profiles) returns the SAME body
    // for every caller — none of them reads the Authorization header or any
    // JWT claim, so the Authorization header is deliberately absent from the
    // cache key and one cached copy can serve all viewers. Per-user state
    // (likes, follows) lives only under /v1/me*, which never matches here.
    //
    // TTL comes from the origin: each handler sends its own Cache-Control
    // (content/home 60s, events 30s) and CloudFront honours it between min and
    // max. defaultTtl applies only if a handler ever forgets to send one.
    //
    // Query strings are part of the key — ?channelId=, ?limit=, ?cursor=.
    const publicReadCachePolicy = new cloudfront.CachePolicy(this, "PublicReadCachePolicy", {
      cachePolicyName: `niltv-${stage}-public-read`,
      comment: "Edge cache for public catalogue GETs (home, content, events, channels, profiles)",
      minTtl: Duration.seconds(0),
      defaultTtl: Duration.seconds(30),
      maxTtl: Duration.seconds(300),
      cookieBehavior: cloudfront.CacheCookieBehavior.none(),
      headerBehavior: cloudfront.CacheHeaderBehavior.none(),
      queryStringBehavior: cloudfront.CacheQueryStringBehavior.all(),
      enableAcceptEncodingGzip: true,
      enableAcceptEncodingBrotli: true,
    });

    /**
     * A cached public-read behaviour.
     *
     * `ALLOW_ALL` is deliberate and load-bearing: `/v1/events*` also carries
     * `POST /v1/events/{id}/vote`. CloudFront only ever caches GET/HEAD, so
     * writes still reach the origin untouched — but restricting the behaviour
     * to GET/HEAD would make CloudFront reject the vote with a 405 before it
     * ever got there. The origin request policy keeps forwarding Authorization
     * so authenticated writes are unaffected; it just isn't in the cache key.
     */
    /**
     * API response headers: CORS narrowed from the managed allow-all policy
     * to the site's own origins (still no credentials - auth is a Bearer
     * header, never a cookie), plus the hardening headers: nosniff, HSTS,
     * DENY framing, referrer policy. `override` so nothing upstream can
     * loosen it.
     */
    const apiHeadersPolicy = new cloudfront.ResponseHeadersPolicy(this, "ApiHeadersPolicy", {
      responseHeadersPolicyName: `niltv-${stage}-api`,
      comment: "CORS allowlist + security headers for /v1/*",
      corsBehavior: {
        accessControlAllowOrigins: webOrigins(stage),
        accessControlAllowHeaders: ["authorization", "content-type"],
        accessControlAllowMethods: ["GET", "HEAD", "OPTIONS", "POST", "PUT", "DELETE"],
        accessControlAllowCredentials: false,
        accessControlMaxAge: Duration.days(1),
        originOverride: true,
      },
      securityHeadersBehavior: {
        contentTypeOptions: { override: true },
        strictTransportSecurity: { accessControlMaxAge: Duration.days(730), includeSubdomains: true, override: true },
        frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
        referrerPolicy: { referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN, override: true },
      },
    });

    const cachedPublicRead = (): cloudfront.BehaviorOptions => ({
      origin: apiOrigin,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
      cachePolicy: publicReadCachePolicy,
      originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
      responseHeadersPolicy: apiHeadersPolicy,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
    });

    /**
     * Media responses, with Cache-Control guaranteed.
     *
     * Everything under /video/{contentId}/ is immutable — a new clip is a new
     * id — so the header should always have been a year. It was set on the
     * objects ingest uploads, but not on the ones MediaConvert writes
     * (re-compression outputs), and older edge copies predate it entirely.
     * Without it a client re-fetches the same poster because nothing tells it
     * that it can keep it.
     *
     * Stamping the header at the edge with `override` makes that impossible to
     * regress, whatever wrote the object. The managed CORS policy cannot carry
     * custom headers, so its behaviour is reproduced here.
     */
    const mediaHeadersPolicy = new cloudfront.ResponseHeadersPolicy(this, "MediaHeadersPolicy", {
      responseHeadersPolicyName: `niltv-${stage}-media`,
      comment: "CORS + immutable Cache-Control for /video/*",
      corsBehavior: {
        accessControlAllowOrigins: ["*"],
        accessControlAllowHeaders: ["*"],
        accessControlAllowMethods: ["GET", "HEAD", "OPTIONS"],
        accessControlAllowCredentials: false,
        originOverride: true,
      },
      customHeadersBehavior: {
        customHeaders: [
          {
            header: "cache-control",
            value: "public, max-age=31536000, immutable",
            override: true,
          },
        ],
      },
    });

    this.distribution = new cloudfront.Distribution(this, "Distribution", {
      comment: `niltv-${stage} API edge`,
      webAclId: webAcl.attrArn,
      // US/Canada/Europe edges only — the MVP audience; cheapest tier.
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      defaultBehavior: {
        origin: apiOrigin,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        // Managed CORS-With-Preflight: stamps ACAO * at the edge so browser
        // clients (Expo web) can read responses even when they were cached
        // from a native request that carried no Origin header.
        responseHeadersPolicy: apiHeadersPolicy,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      },
      additionalBehaviors: {
        "/v1/config": {
          origin: apiOrigin,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
          cachePolicy: configCachePolicy,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          responseHeadersPolicy: apiHeadersPolicy,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        },
        // The read catalogue. Before this existed every one of these was a
        // CloudFront miss on every request — a HAR of a normal session showed
        // cold reads at 850–1200 ms against 72–134 ms warm, with each one
        // spending a Lambda invocation. These are the endpoints a vote-day
        // crowd hammers, so they are the ones that must be absorbed at the
        // edge rather than by concurrency.
        "/v1/home": cachedPublicRead(),
        "/v1/content*": cachedPublicRead(),
        "/v1/events*": cachedPublicRead(),
        "/v1/channels*": cachedPublicRead(),
        "/v1/profiles*": cachedPublicRead(),
        // HLS playback (design §6.8, §8): segments carry versioned names and
        // manifests are small — CachingOptimized is the right default.
        "/video/*": {
          origin: videoOrigin,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
          cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
          compress: true,
          responseHeadersPolicy: mediaHeadersPolicy,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        },
        // The content-library CSV a spreadsheet reads via IMPORTDATA
        // (written by ingest-social after every run). Deliberately NOT under
        // /video/* — that behaviour stamps a year-long immutable Cache-Control
        // at the edge, and this file must refresh after every ingest. The
        // public-read cache policy honours the object's own max-age=300.
        "/library/*": {
          origin: videoOrigin,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
          cachePolicy: publicReadCachePolicy,
          compress: true,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        },
        // Partner feeds (partner content API): Media RSS + JSON per partner,
        // rebuilt every 15 minutes by the partner stack. Same short-cache
        // treatment as the library CSV — never the immutable /video/* header.
        "/feeds/*": {
          origin: videoOrigin,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
          cachePolicy: publicReadCachePolicy,
          compress: true,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        },
      },
    });

    new CfnOutput(this, "DistributionDomain", { value: this.distribution.distributionDomainName });

    // ── Partner download distribution (partner content API) ───────────────
    // A second door on the same bytes. /video/* above stays public for the
    // app and the 600-odd watch pages; this distribution requires a signed
    // URL (CloudFront key group) and serves the same video bucket with origin
    // path /video — so `/{id}/master.mp4` is the stored clip and
    // `/{id}/mezz.mp4` the partner mezzanine — plus the masters bucket for
    // /masters/* (the untouched uploads) and /originals/* (archived
    // originals). The public key comes from scripts/partner-dl-keypair.ts
    // and is committed; the private half lives in Secrets Manager and the
    // api/partner stacks sign with it. No key file for this stage → no
    // distribution, with a synth-time warning, so a fresh stage can never
    // deploy a door it cannot lock.
    const publicKeyPath = join(__dirname, "keys", `partner-dl.${stage}.pub.pem`);
    if (!existsSync(publicKeyPath)) {
      Annotations.of(this).addWarning(
        `no partner download public key at ${publicKeyPath} — run scripts/partner-dl-keypair.ts --stage ${stage}; partner distribution skipped`,
      );
    } else {
      const publicKey = new cloudfront.PublicKey(this, "PartnerDlPublicKey", {
        publicKeyName: `niltv-${stage}-partner-dl`,
        encodedKey: readFileSync(publicKeyPath, "utf8"),
        comment: "Signs partner download URLs (partner content API)",
      });
      const keyGroup = new cloudfront.KeyGroup(this, "PartnerDlKeyGroup", {
        keyGroupName: `niltv-${stage}-partner-dl`,
        items: [publicKey],
      });
      const partnerVideoOrigin = S3BucketOrigin.withOriginAccessControl(videoOriginBucket, {
        originAccessControl: videoOac,
        originPath: "/video",
      });
      const mastersOriginBucket = s3.Bucket.fromBucketAttributes(this, "MastersOriginBucket", {
        bucketName: mastersBucket.bucketName,
        region: this.region,
      });
      const mastersOrigin = S3BucketOrigin.withOriginAccessControl(mastersOriginBucket, {
        originAccessControl: new cloudfront.S3OriginAccessControl(this, "MastersOac", {
          originAccessControlName: `niltv-${stage}-masters`,
          description: "CloudFront read access to the NILTV masters bucket (partner downloads only)",
        }),
      });
      const signedDownload = (origin: cloudfront.IOrigin): cloudfront.BehaviorOptions => ({
        origin,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        compress: false,
        trustedKeyGroups: [keyGroup],
        responseHeadersPolicy: mediaHeadersPolicy,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
      });
      const partnerDistribution = new cloudfront.Distribution(this, "PartnerDownloadDistribution", {
        comment: `niltv-${stage} partner downloads (signed URLs)`,
        webAclId: webAcl.attrArn,
        priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
        defaultBehavior: signedDownload(partnerVideoOrigin),
        additionalBehaviors: {
          "/masters/*": signedDownload(mastersOrigin),
          "/originals/*": signedDownload(mastersOrigin),
        },
      });
      // The api and partner stacks read these at runtime to sign URLs —
      // parameters, not stack exports, so neither stack depends on this one.
      new ssm.StringParameter(this, "PartnerDlDomainParam", {
        parameterName: `/niltv/${stage}/partner-dl/domain`,
        stringValue: partnerDistribution.distributionDomainName,
      });
      new ssm.StringParameter(this, "PartnerDlKeyPairParam", {
        parameterName: `/niltv/${stage}/partner-dl/key-pair-id`,
        stringValue: publicKey.publicKeyId,
      });
      new CfnOutput(this, "PartnerDownloadDomain", { value: partnerDistribution.distributionDomainName });
    }
  }
}
