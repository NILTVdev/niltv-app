/**
 * Edge behaviour assertions.
 *
 * The catalogue endpoints are cached at the edge with the Authorization header
 * deliberately left out of the cache key — correct only for as long as every
 * path behind those behaviours returns the same body to everybody. If a future
 * path pattern ever covers an authenticated route, CloudFront would serve one
 * signed-in user's response to the next caller. That is the failure this file
 * exists to make impossible to introduce quietly.
 */
import { App, Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import { describe, expect, it } from "vitest";
import { EdgeStack } from "./edge-stack";

function synth(stage = "test") {
  const app = new App();
  const host = new Stack(app, "host", { env: { account: "111111111111", region: "us-east-1" } });
  const httpApi = new apigwv2.HttpApi(host, "Api");
  const secret = new secretsmanager.Secret(host, "Secret");
  const bucket = new s3.Bucket(host, "Video");
  const masters = new s3.Bucket(host, "Masters");
  const stack = new EdgeStack(app, "edge", {
    env: { account: "111111111111", region: "us-east-1" },
    stage,
    httpApi,
    originVerifySecret: secret,
    videoBucket: bucket,
    mastersBucket: masters,
  });
  return Template.fromStack(stack);
}

type DistributionResource = {
  Properties: {
    DistributionConfig: {
      Comment?: string;
      DefaultCacheBehavior: { TrustedKeyGroups?: unknown[]; AllowedMethods?: string[] };
      CacheBehaviors?: { PathPattern: string; TrustedKeyGroups?: unknown[] }[];
      Origins: { OriginPath?: string }[];
    };
  };
};

/** Path patterns that CloudFront is configured to cache, in priority order. */
function cachedPatterns(template: Template): string[] {
  const dist = Object.values(template.findResources("AWS::CloudFront::Distribution"))[0] as {
    Properties: { DistributionConfig: { CacheBehaviors?: { PathPattern: string }[] } };
  };
  return (dist.Properties.DistributionConfig.CacheBehaviors ?? []).map((b) => b.PathPattern);
}

describe("EdgeStack cache behaviours", () => {
  const template = synth();

  it("caches the public catalogue endpoints", () => {
    const patterns = cachedPatterns(template);
    for (const p of ["/v1/home", "/v1/content*", "/v1/events*", "/v1/channels*", "/v1/profiles*"]) {
      expect(patterns).toContain(p);
    }
  });

  it("never caches anything under /v1/me", () => {
    // /v1/me carries per-user likes, follows and push settings. It must fall
    // through to the default CACHING_DISABLED behaviour.
    for (const pattern of cachedPatterns(template)) {
      const prefix = pattern.replace(/\*$/, "");
      expect("/v1/me".startsWith(prefix)).toBe(false);
      expect("/v1/me/likes/abc".startsWith(prefix)).toBe(false);
    }
  });

  it("never caches telemetry or newsletter writes", () => {
    for (const pattern of cachedPatterns(template)) {
      const prefix = pattern.replace(/\*$/, "");
      expect("/v1/telemetry".startsWith(prefix)).toBe(false);
      expect("/v1/newsletter".startsWith(prefix)).toBe(false);
    }
  });

  it("keeps the vote path on a behaviour that allows POST", () => {
    // /v1/events/{id}/vote sits inside the cached /v1/events* behaviour.
    // Restricting that behaviour to GET/HEAD would make CloudFront reject the
    // vote with a 405 before it ever reached the origin.
    const dist = Object.values(template.findResources("AWS::CloudFront::Distribution"))[0] as {
      Properties: {
        DistributionConfig: { CacheBehaviors?: { PathPattern: string; AllowedMethods: string[] }[] };
      };
    };
    const events = dist.Properties.DistributionConfig.CacheBehaviors?.find(
      (b) => b.PathPattern === "/v1/events*",
    );
    expect(events?.AllowedMethods).toEqual(expect.arrayContaining(["POST"]));
  });

  it("stamps immutable Cache-Control on media", () => {
    template.hasResourceProperties("AWS::CloudFront::ResponseHeadersPolicy", {
      ResponseHeadersPolicyConfig: {
        CustomHeadersConfig: {
          Items: [
            {
              Header: "cache-control",
              Value: "public, max-age=31536000, immutable",
              Override: true,
            },
          ],
        },
      },
    });
  });
});

describe("EdgeStack WAF rate limits", () => {
  const template = synth();

  function rules() {
    const acl = Object.values(template.findResources("AWS::WAFv2::WebACL"))[0] as {
      Properties: { Rules: { Name: string; Statement: Record<string, never> }[] };
    };
    return acl.Properties.Rules;
  }
  const limitOf = (name: string) => {
    const r = rules().find((x) => x.Name === name) as
      | { Statement: { RateBasedStatement?: { Limit: number; ScopeDownStatement?: unknown } } }
      | undefined;
    return r?.Statement?.RateBasedStatement;
  };

  // A real session issues ~181 CloudFront requests per 5-minute window.
  // A shared campus NAT multiplies that by every student on it, so a low
  // per-IP ceiling blocks the whole campus. WAF blocks TOTALLY once engaged,
  // not partially.
  const SESSION_API_REQ_PER_WINDOW = 38;
  const SESSION_MEDIA_REQ_PER_WINDOW = 143;

  it("lets a realistic campus share one IP on the API", () => {
    const api = limitOf("RateLimitApiPerIp");
    expect(api).toBeDefined();
    const concurrentUsers = api!.Limit / SESSION_API_REQ_PER_WINDOW;
    expect(concurrentUsers).toBeGreaterThan(200);
  });

  it("lets a realistic campus share one IP on media", () => {
    const media = limitOf("RateLimitMediaPerIp");
    expect(media).toBeDefined();
    const concurrentUsers = media!.Limit / SESSION_MEDIA_REQ_PER_WINDOW;
    expect(concurrentUsers).toBeGreaterThan(200);
  });

  it("does not let media requests consume the API budget", () => {
    // The original single rule counted every request together, so video and
    // poster fetches — ~4 in 5 of them — ate the ceiling that browsing needed.
    expect(limitOf("RateLimitApiPerIp")?.ScopeDownStatement).toBeDefined();
    expect(limitOf("RateLimitMediaPerIp")?.ScopeDownStatement).toBeDefined();
    expect(rules().some((r) => r.Name === "RateLimitPerIp")).toBe(false);
  });

  it("keeps a vote ceiling that a campus cannot trip", () => {
    // Defence-in-depth only: the one-vote-per-account guarantee is the
    // conditional DynamoDB write, which holds under concurrent retries.
    expect(limitOf("RateLimitVote")!.Limit).toBeGreaterThanOrEqual(1000);
  });

  it("still rate-limits every abuse-sensitive path", () => {
    const names = rules().map((r) => r.Name);
    for (const n of ["RateLimitVote", "RateLimitNewsletter", "RateLimitApiPerIp", "RateLimitMediaPerIp"]) {
      expect(names).toContain(n);
    }
    expect(names).toContain("AWSManagedRulesCommonRuleSet");
  });
});

describe("EdgeStack partner content API", () => {
  it("skips the partner download distribution for a stage with no committed public key", () => {
    const template = synth("test");
    expect(Object.keys(template.findResources("AWS::CloudFront::Distribution"))).toHaveLength(1);
    expect(Object.keys(template.findResources("AWS::CloudFront::KeyGroup"))).toHaveLength(0);
  });

  it("serves /feeds/* from the video bucket with the short public cache, never the immutable media header", () => {
    const template = synth("test");
    const dist = Object.values(template.findResources("AWS::CloudFront::Distribution"))[0] as {
      Properties: { DistributionConfig: { CacheBehaviors: { PathPattern: string; ResponseHeadersPolicyId?: unknown }[] } };
    };
    const feeds = dist.Properties.DistributionConfig.CacheBehaviors.find((b) => b.PathPattern === "/feeds/*");
    expect(feeds).toBeDefined();
    expect(feeds?.ResponseHeadersPolicyId).toBeUndefined();
  });

  it("rate-limits /partner/ per IP at the edge", () => {
    const template = synth("test");
    const acl = Object.values(template.findResources("AWS::WAFv2::WebACL"))[0] as {
      Properties: { Rules: { Name: string; Priority: number }[] };
    };
    const rule = acl.Properties.Rules.find((r) => r.Name === "RateLimitPartnerApi");
    expect(rule).toBeDefined();
    const priorities = acl.Properties.Rules.map((r) => r.Priority);
    expect(new Set(priorities).size).toBe(priorities.length);
  });

  it("dev: requires a signed URL on every partner download behaviour and publishes the signing parameters", () => {
    // The dev public key is committed (lib/keys/partner-dl.dev.pub.pem), so
    // synthesizing as dev exercises the real distribution.
    const template = synth("dev");
    const distributions = Object.values(template.findResources("AWS::CloudFront::Distribution")) as DistributionResource[];
    const partner = distributions.find((d) => d.Properties.DistributionConfig.Comment?.includes("partner downloads"));
    expect(partner).toBeDefined();
    const config = partner!.Properties.DistributionConfig;
    expect(config.DefaultCacheBehavior.TrustedKeyGroups).toHaveLength(1);
    expect(config.DefaultCacheBehavior.AllowedMethods).toEqual(["GET", "HEAD"]);
    for (const behaviour of config.CacheBehaviors ?? []) {
      expect(behaviour.TrustedKeyGroups, behaviour.PathPattern).toHaveLength(1);
    }
    expect((config.CacheBehaviors ?? []).map((b) => b.PathPattern).sort()).toEqual(["/masters/*", "/originals/*"]);
    expect(config.Origins.some((o) => o.OriginPath === "/video")).toBe(true);

    // The public /video/* door on the main distribution is untouched.
    const main = distributions.find((d) => d.Properties.DistributionConfig.Comment?.includes("API edge"));
    const video = main?.Properties.DistributionConfig.CacheBehaviors?.find((b) => b.PathPattern === "/video/*");
    expect(video?.TrustedKeyGroups).toBeUndefined();

    template.hasResourceProperties("AWS::SSM::Parameter", { Name: "/niltv/dev/partner-dl/domain" });
    template.hasResourceProperties("AWS::SSM::Parameter", { Name: "/niltv/dev/partner-dl/key-pair-id" });
  });
});
