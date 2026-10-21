import { App, Stack } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import { describe, expect, it } from "vitest";
import { PORTAL_LEADING_KEYS, PortalStack, portalOrigins } from "./portal-stack";

function synth(stage = "test", context: Record<string, string> = {}): Template {
  const app = new App({ context });
  const host = new Stack(app, "host", { env: { account: "111111111111", region: "us-east-1" } });
  const table = new dynamodb.Table(host, "Table", {
    partitionKey: { name: "PK", type: dynamodb.AttributeType.STRING },
    sortKey: { name: "SK", type: dynamodb.AttributeType.STRING },
  });
  const stack = new PortalStack(app, "portal", {
    env: { account: "111111111111", region: "us-east-1" },
    stage,
    table,
    userPool: new cognito.UserPool(host, "Pool"),
    audienceClientIds: ["web-client"],
  });
  return Template.fromStack(stack);
}

describe("PortalStack", () => {
  const template = synth();

  it("puts every route behind the Cognito JWT authorizer", () => {
    const routes = template.findResources("AWS::ApiGatewayV2::Route");
    expect(Object.keys(routes).length).toBeGreaterThanOrEqual(30);
    for (const route of Object.values(routes)) {
      expect(route["Properties"]["AuthorizationType"]).toBe("JWT");
    }
    template.hasResourceProperties("AWS::ApiGatewayV2::Authorizer", {
      AuthorizerType: "JWT",
      JwtConfiguration: { Audience: ["web-client"] },
    });
  });

  it("scopes table access to portal partitions on every function", () => {
    const policies = template.findResources("AWS::IAM::Policy");
    for (const policy of Object.values(policies)) {
      for (const st of policy["Properties"]["PolicyDocument"]["Statement"] as { Action: string | string[]; Condition?: Record<string, Record<string, string[]>> }[]) {
        const actions = Array.isArray(st.Action) ? st.Action : [st.Action];
        if (!actions.some((a) => a.startsWith("dynamodb:"))) continue;
        const keys = st.Condition?.["ForAllValues:StringLike"]?.["dynamodb:LeadingKeys"];
        expect(keys, `unscoped ${actions.join(",")}`).toBeDefined();
        const writes = actions.some((a) => /Put|Update|Delete/.test(a));
        // Writes never reach the catalogue; only the read-only statement names it.
        if (writes) expect(keys).toEqual(PORTAL_LEADING_KEYS);
        else expect(keys!.every((k) => PORTAL_LEADING_KEYS.includes(k) || k === "PROFILES#ALL" || k === "ATHLETE#*")).toBe(true);
      }
    }
  });

  it("allows only the portal origins in CORS", () => {
    template.hasResourceProperties("AWS::ApiGatewayV2::Api", {
      CorsConfiguration: Match.objectLike({ AllowOrigins: ["https://portal-dev.niltv.com", "http://localhost:5190"] }),
    });
    expect(portalOrigins("prod", undefined)).toEqual(["https://portal.niltv.com"]);
    expect(portalOrigins("dev", "https://dev.x.amplifyapp.com, ")).toContain("https://dev.x.amplifyapp.com");
  });

  it("sends email through a queue with a dead-letter queue", () => {
    template.hasResourceProperties("AWS::SQS::Queue", {
      QueueName: "niltv-test-portal-notify",
      RedrivePolicy: Match.objectLike({ maxReceiveCount: 3 }),
    });
    template.hasResourceProperties("AWS::Lambda::EventSourceMapping", {
      FunctionResponseTypes: ["ReportBatchItemFailures"],
    });
  });

  it("runs the onboarding sync every 30 minutes on prod only, unless context turns it on", () => {
    const syncRules = (t: Template): number =>
      Object.keys(t.findResources("AWS::Events::Rule", { Properties: { ScheduleExpression: "rate(30 minutes)" } })).length;
    expect(syncRules(template)).toBe(0);
    expect(syncRules(synth("prod"))).toBe(1);
    expect(syncRules(synth("dev", { "niltv:portalRosterSync:dev": "on" }))).toBe(1);
  });

  it("sends summaries every 15 minutes on every stage, one run at a time", () => {
    template.hasResourceProperties("AWS::Events::Rule", {
      Name: "niltv-test-portal-summary",
      ScheduleExpression: "rate(15 minutes)",
    });
    template.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: Match.stringLikeRegexp("portal-summary"),
      ReservedConcurrentExecutions: 1,
    });
  });

  it("lets only the notifier read the private push key", () => {
    const readers = Object.values(template.findResources("AWS::IAM::Policy")).filter((policy) =>
      JSON.stringify(policy["Properties"]["PolicyDocument"]).includes("portal-vapid-private"),
    );
    expect(readers).toHaveLength(1);
    expect(JSON.stringify(readers[0]!["Properties"]["Roles"])).toMatch(/NotifyFn/);
  });
});
