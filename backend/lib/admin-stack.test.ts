import { App, Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import { describe, expect, it } from "vitest";
import { AdminStack } from "./admin-stack";

function synth(): Template {
  const app = new App();
  const host = new Stack(app, "host", { env: { account: "111111111111", region: "us-east-1" } });
  const table = new dynamodb.Table(host, "Table", { partitionKey: { name: "PK", type: dynamodb.AttributeType.STRING }, sortKey: { name: "SK", type: dynamodb.AttributeType.STRING } });
  const stack = new AdminStack(app, "admin", {
    env: { account: "111111111111", region: "us-east-1" },
    stage: "test",
    table,
    mastersBucket: new s3.Bucket(host, "Masters"),
    userPool: new cognito.UserPool(host, "Pool"),
    audienceClientIds: ["client"],
    partnerKeyPepper: new secretsmanager.Secret(host, "Pepper"),
  });
  return Template.fromStack(stack);
}

/** Every DynamoDB action a policy statement grants on rows with the given leading key. */
function actionsOn(template: Template, roleLogicalIdPrefix: string, leadingKey: string): Set<string> {
  const out = new Set<string>();
  const policies = template.findResources("AWS::IAM::Policy");
  for (const policy of Object.values(policies)) {
    const props = policy["Properties"] as { Roles?: { Ref?: string }[]; PolicyDocument: { Statement: { Action: string | string[]; Condition?: Record<string, Record<string, string[]>> }[] } };
    if (!(props.Roles ?? []).some((r) => String(r.Ref ?? "").startsWith(roleLogicalIdPrefix))) continue;
    for (const st of props.PolicyDocument.Statement) {
      const keys = st.Condition?.["ForAllValues:StringLike"]?.["dynamodb:LeadingKeys"] ?? [];
      if (!keys.includes(leadingKey)) continue;
      for (const a of Array.isArray(st.Action) ? st.Action : [st.Action]) out.add(a);
    }
  }
  return out;
}

describe("AdminStack least-privilege grants", () => {
  const template = synth();

  it("content-upsert can read, write and update content rows (read-first override recording)", () => {
    const actions = actionsOn(template, "ContentUpsertFnServiceRole", "CONTENT#*");
    expect([...actions].sort()).toEqual(["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem"]);
    expect(actionsOn(template, "ContentUpsertFnServiceRole", "SERIES#*").has("dynamodb:GetItem")).toBe(true);
  });

  it("publish and withdraw can re-stamp the index on content rows and read series", () => {
    expect(actionsOn(template, "PublishFnServiceRole", "CONTENT#*").has("dynamodb:UpdateItem")).toBe(true);
    expect(actionsOn(template, "PublishFnServiceRole", "SERIES#*").has("dynamodb:GetItem")).toBe(true);
  });
});
