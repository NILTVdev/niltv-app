/**
 * Ingest stack assertions: the library sync flag defaults on in dev and off
 * in prod, follows its context value, and the ingest function can Scan the
 * table (the sync reads every content and channel row).
 */
import { App, Stack } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as s3 from "aws-cdk-lib/aws-s3";
import { describe, expect, it } from "vitest";
import { IngestStack } from "./ingest-stack";

function synth(stage: string, context: Record<string, string> = {}) {
  const app = new App({ context });
  const env = { account: "111111111111", region: "us-east-1" };
  const host = new Stack(app, "host", { env });
  const table = new dynamodb.Table(host, "Table", {
    partitionKey: { name: "PK", type: dynamodb.AttributeType.STRING },
    sortKey: { name: "SK", type: dynamodb.AttributeType.STRING },
  });
  const stack = new IngestStack(app, "ingest", {
    env,
    stage,
    table,
    outputBucket: new s3.Bucket(host, "Video"),
    mastersBucket: new s3.Bucket(host, "Masters"),
  });
  return Template.fromStack(stack);
}

function ingestEnv(template: Template): Record<string, string> {
  const fns = template.findResources("AWS::Lambda::Function", {
    Properties: { FunctionName: Match.stringLikeRegexp("ingest-social") },
  });
  const [fn] = Object.values(fns) as { Properties: { Environment: { Variables: Record<string, string> } } }[];
  return fn!.Properties.Environment.Variables;
}

type Statement = { Action: string | string[]; Resource: unknown };

/** Every resource an ssm:GetParameter statement names, flattened to strings. */
function ssmParams(template: Template): string[] {
  const policies = template.findResources("AWS::IAM::Policy");
  return Object.values(policies)
    .flatMap((p) => (p as { Properties: { PolicyDocument: { Statement: Statement[] } } }).Properties.PolicyDocument.Statement)
    .filter((s) => (Array.isArray(s.Action) ? s.Action : [s.Action]).includes("ssm:GetParameter"))
    .flatMap((s) => (Array.isArray(s.Resource) ? s.Resource : [s.Resource]))
    .map((r) => JSON.stringify(r));
}

describe("IngestStack library sync", () => {
  const dev = synth("dev");
  const prod = synth("prod");
  const prodOn = synth("prod", { "niltv:librarySync:prod": "true" });

  it("is on by default in dev and off by default in prod", () => {
    expect(ingestEnv(dev)["LIBRARY_SYNC_ENABLED"]).toBe("true");
    expect(ingestEnv(prod)["LIBRARY_SYNC_ENABLED"]).toBe("false");
  });

  it("posts to the stage's own dashboard, never prod from dev", () => {
    expect(ingestEnv(dev)["LIBRARY_SYNC_URL"]).toBe("https://api-dev.niltv.com");
    expect(ingestEnv(prod)["LIBRARY_SYNC_URL"]).toBe("https://api.niltv.com");
    const devOverride = synth("dev", { "niltv:dashboardApiUrl:dev": "https://dashboard.example.test" });
    expect(ingestEnv(devOverride)["LIBRARY_SYNC_URL"]).toBe("https://dashboard.example.test");
  });

  it("reads the sync key from its own parameter: the dev dashboard key in dev, the brand key in prod", () => {
    expect(ingestEnv(dev)["LIBRARY_SYNC_API_KEY_PARAM"]).toBe("/niltv/dev/dashboard-dev-api-key");
    expect(ingestEnv(dev)["DASHBOARD_API_KEY_PARAM"]).toBe("/niltv/dev/dashboard-api-key");
    expect(ingestEnv(prod)["LIBRARY_SYNC_API_KEY_PARAM"]).toBe("/niltv/prod/dashboard-api-key");
    const devOverride = synth("dev", { "niltv:librarySyncKeyParam:dev": "/niltv/dev/other-key" });
    expect(ingestEnv(devOverride)["LIBRARY_SYNC_API_KEY_PARAM"]).toBe("/niltv/dev/other-key");
  });

  it("grants ssm:GetParameter on the sync key parameter", () => {
    expect(ssmParams(dev)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("parameter/niltv/dev/dashboard-api-key"),
        expect.stringContaining("parameter/niltv/dev/dashboard-dev-api-key"),
      ]),
    );
    const override = synth("dev", { "niltv:librarySyncKeyParam:dev": "/niltv/dev/other-key" });
    expect(ssmParams(override)).toEqual(expect.arrayContaining([expect.stringContaining("parameter/niltv/dev/other-key")]));
    // Prod reuses the brand-read key, which is already granted.
    expect(ssmParams(prod).filter((a) => a.includes("dashboard-dev-api-key"))).toEqual([]);
    expect(ssmParams(prod)).toEqual(expect.arrayContaining([expect.stringContaining("parameter/niltv/prod/dashboard-api-key")]));
  });

  it("follows the niltv:librarySync:{stage} context value", () => {
    expect(ingestEnv(prodOn)["LIBRARY_SYNC_ENABLED"]).toBe("true");
  });

  it("lets the ingest function Scan the table", () => {
    const policies = dev.findResources("AWS::IAM::Policy");
    const actions = Object.values(policies).flatMap((p) =>
      (p as { Properties: { PolicyDocument: { Statement: { Action: string | string[] }[] } } }).Properties.PolicyDocument.Statement.flatMap(
        (s) => (Array.isArray(s.Action) ? s.Action : [s.Action]),
      ),
    );
    expect(actions).toContain("dynamodb:Scan");
    expect(actions).toContain("dynamodb:Query");
  });
});
