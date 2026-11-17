import { App, Stack } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PORTAL_LEADING_KEYS, PortalStack, SWALLOWED_TERMS, portalOrigins } from "./portal-stack";

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
      ScalingConfig: { MaximumConcurrency: 5 },
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

  it("lets only the members API and the roster sync delete a Cognito user", () => {
    const deleters = Object.values(template.findResources("AWS::IAM::Policy")).filter((policy) =>
      JSON.stringify(policy["Properties"]["PolicyDocument"]).includes("cognito-idp:AdminDeleteUser"),
    );
    expect(deleters).toHaveLength(2);
    const roles = JSON.stringify(deleters.map((policy) => policy["Properties"]["Roles"]));
    expect(roles).toMatch(/MembersFn/);
    expect(roles).toMatch(/RosterSyncFn/);
  });

  it("lets only the notifier read the private push key", () => {
    const readers = Object.values(template.findResources("AWS::IAM::Policy")).filter((policy) =>
      JSON.stringify(policy["Properties"]["PolicyDocument"]).includes("portal-vapid-private"),
    );
    expect(readers).toHaveLength(1);
    expect(JSON.stringify(readers[0]!["Properties"]["Roles"])).toMatch(/NotifyFn/);
  });

  // ── Alarms and access log ────────────────────────────────────────────────
  it("alarms on 5xx, function errors, the dead-letter queue, queue age and swallowed errors", () => {
    const names = Object.values(template.findResources("AWS::CloudWatch::Alarm")).map(
      (alarm) => alarm["Properties"]["AlarmName"] as string,
    );
    expect(names.sort()).toEqual(
      [
        "niltv-test-portal-api-5xx",
        "niltv-test-portal-notify-errors",
        "niltv-test-portal-summary-errors",
        "niltv-test-portal-roster-sync-errors",
        "niltv-test-portal-notify-dlq",
        "niltv-test-portal-notify-dlq-new",
        "niltv-test-portal-notify-queue-age",
        "niltv-test-portal-swallowed-errors",
      ].sort(),
    );
    template.resourceCountIs("AWS::Logs::MetricFilter", 11);
    template.hasResourceProperties("AWS::Logs::MetricFilter", {
      FilterPattern: Match.stringLikeRegexp("one summary failed"),
    });
    template.hasResourceProperties("AWS::Logs::MetricFilter", {
      FilterPattern: Match.stringLikeRegexp("push failed"),
    });
    for (const term of ["not queued", "limit check failed", "limit refund failed", "not cleared"]) {
      template.hasResourceProperties("AWS::Logs::MetricFilter", { FilterPattern: Match.stringLikeRegexp(term) });
    }
  });

  it("pages on each new dead letter, and clears the presence alarm after a redrive", () => {
    const alarms = Object.values(template.findResources("AWS::CloudWatch::Alarm")).map((a) => a["Properties"]);
    const presence = alarms.find((p) => p["AlarmName"] === "niltv-test-portal-notify-dlq")!;
    expect(presence["MetricName"]).toBe("ApproximateNumberOfMessagesVisible");
    expect(presence["OKActions"]).toHaveLength(1);
    expect(presence["OKActions"]).toEqual(presence["AlarmActions"]);

    const growth = alarms.find((p) => p["AlarmName"] === "niltv-test-portal-notify-dlq-new")!;
    expect(growth["Threshold"]).toBe(1);
    expect(growth["ComparisonOperator"]).toBe("GreaterThanOrEqualToThreshold");
    const metrics = growth["Metrics"] as { Id: string; Expression?: string; ReturnData?: boolean; MetricStat?: { Metric: { MetricName: string } } }[];
    expect(metrics.find((m) => m.Expression)?.Expression).toBe("DIFF(m1)");
    const m1 = metrics.find((m) => m.Id === "m1")!;
    expect(m1.MetricStat?.Metric.MetricName).toBe("ApproximateNumberOfMessagesVisible");
    expect(m1.ReturnData).toBe(false);
    expect(JSON.stringify(growth)).not.toContain("NumberOfMessagesSent");
  });

  it("matches every swallowed failure the portal code logs", () => {
    // console.error / console.warn lines that do not need the filter: the
    // notifier retries through SQS (DLQ alarm), a thrown route is a 500
    // (5xx alarm), and a roster conflict is counted in the sync result.
    const covered = [/portal-notify: notice failed/, /portal: \$\{event\.routeKey\} failed/, /member already linked/];
    const src = join(__dirname, "..", "src");
    const files = [
      ...readdirSync(join(src, "handlers", "portal")).map((f) => join(src, "handlers", "portal", f)),
      ...readdirSync(join(src, "lib", "portal")).map((f) => join(src, "lib", "portal", f)),
    ].filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
    const lines = files.flatMap((f) =>
      readFileSync(f, "utf8")
        .split(/\r?\n/)
        .filter((line) => /console\.(error|warn)\(/.test(line)),
    );
    expect(lines.length).toBeGreaterThan(10);
    const missed = lines.filter(
      (line) => !SWALLOWED_TERMS.some((term) => line.includes(term)) && !covered.some((re) => re.test(line)),
    );
    expect(missed).toEqual([]);
  });

  it("adds the SES reputation alarms on prod only", () => {
    const prod = synth("prod");
    prod.hasResourceProperties("AWS::CloudWatch::Alarm", { MetricName: "Reputation.BounceRate", Threshold: 0.04 });
    prod.hasResourceProperties("AWS::CloudWatch::Alarm", { MetricName: "Reputation.ComplaintRate" });
    const ses = Object.values(template.findResources("AWS::CloudWatch::Alarm")).filter(
      (alarm) => alarm["Properties"]["Namespace"] === "AWS/SES",
    );
    expect(ses).toHaveLength(0);
  });

  it("writes an access log with the caller's sub and never the Authorization header", () => {
    const stages = Object.values(template.findResources("AWS::ApiGatewayV2::Stage"));
    expect(stages).toHaveLength(1);
    const format = stages[0]!["Properties"]["AccessLogSettings"]["Format"] as string;
    const fields = JSON.parse(format) as Record<string, string>;
    expect(fields["sub"]).toBe("$context.authorizer.claims.sub");
    expect(fields["path"]).toBe("$context.path");
    expect(format.toLowerCase()).not.toMatch(/authorization/);
    template.hasResourceProperties("AWS::Logs::LogGroup", {
      LogGroupName: "/aws/apigateway/niltv-test-portal-access",
      RetentionInDays: 30,
    });
  });
});
