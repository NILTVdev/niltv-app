import { App, Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import type { Construct } from "constructs";
import { describe, expect, it, vi } from "vitest";
import { ApiStack } from "./api-stack";

// IAM wiring does not depend on bundling every handler in the API stack.
vi.mock("./fn", async () => {
  const lambda = await import("aws-cdk-lib/aws-lambda");
  return {
    makeFn: (scope: Construct, id: string) => new lambda.Function(scope, id, {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: "index.handler",
      code: lambda.Code.fromInline("exports.handler = async () => {}"),
    }),
  };
});

describe("athlete directory infrastructure", () => {
  it("allows the directory function to query the creator index", () => {
    const app = new App();
    const host = new Stack(app, "host", { env: { account: "111111111111", region: "us-east-1" } });
    const table = new dynamodb.Table(host, "Table", {
      partitionKey: { name: "PK", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "SK", type: dynamodb.AttributeType.STRING },
      stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
    });
    const userPool = new cognito.UserPool(host, "Pool");
    const stack = new ApiStack(app, "api", {
      env: { account: "111111111111", region: "us-east-1" },
      stage: "test",
      table,
      userPool,
      userPoolClient: new cognito.UserPoolClient(host, "Client", { userPool }),
      partnerKeyPepper: new secretsmanager.Secret(host, "Pepper"),
    });
    const policies = Object.values(Template.fromStack(stack).findResources("AWS::IAM::Policy"));
    const directoryPolicy = policies.find((policy) =>
      (policy["Properties"]["Roles"] as { Ref?: string }[] | undefined)
        ?.some((role) => role.Ref?.startsWith("ProfilesListFnServiceRole")),
    );
    const statements = directoryPolicy?.["Properties"]["PolicyDocument"]["Statement"] as
      { Action: string | string[]; Resource: unknown }[] | undefined;
    expect(statements?.some((statement) =>
      [statement.Action].flat().includes("dynamodb:Query") && JSON.stringify(statement.Resource).includes("/index/GSI2"),
    )).toBe(true);
  });
});
