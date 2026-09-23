/**
 * Partner stack assertions: the asynchronous half of the partner content API
 * synthesizes with its queue, dead-letter queue, schedule and alarms, and the
 * feed builder can only write under feeds/*.
 */
import { App, Stack } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as s3 from "aws-cdk-lib/aws-s3";
import { describe, expect, it } from "vitest";
import { PartnerStack } from "./partner-stack";

function synth() {
  const app = new App();
  const host = new Stack(app, "host", { env: { account: "111111111111", region: "us-east-1" } });
  const table = new dynamodb.Table(host, "Table", {
    partitionKey: { name: "PK", type: dynamodb.AttributeType.STRING },
    sortKey: { name: "SK", type: dynamodb.AttributeType.STRING },
    stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
  });
  const bucket = new s3.Bucket(host, "Video");
  const stack = new PartnerStack(app, "partner", {
    env: { account: "111111111111", region: "us-east-1" },
    stage: "test",
    table,
    outputBucket: bucket,
  });
  return Template.fromStack(stack);
}

describe("PartnerStack", () => {
  const template = synth();

  it("rebuilds feeds on a 15-minute schedule", () => {
    template.hasResourceProperties("AWS::Events::Rule", {
      Name: "niltv-test-partner-feed-build",
      ScheduleExpression: "rate(15 minutes)",
    });
  });

  it("parks failed webhook deliveries in a dead-letter queue after five attempts, and alarms on it", () => {
    template.hasResourceProperties("AWS::SQS::Queue", {
      QueueName: "niltv-test-partner-webhooks",
      RedrivePolicy: Match.objectLike({ maxReceiveCount: 5 }),
    });
    template.hasResourceProperties("AWS::CloudWatch::Alarm", { AlarmName: "niltv-test-partner-webhook-dlq" });
  });

  it("consumes the table stream with batch item failures reported", () => {
    template.hasResourceProperties("AWS::Lambda::EventSourceMapping", {
      StartingPosition: "LATEST",
      FunctionResponseTypes: ["ReportBatchItemFailures"],
      BisectBatchOnFunctionError: true,
    });
  });

  it("lets the feed builder write only under feeds/*", () => {
    const policies = template.findResources("AWS::IAM::Policy");
    const statements = Object.values(policies).flatMap(
      (p) => (p as { Properties: { PolicyDocument: { Statement: { Action: unknown; Resource: unknown }[] } } }).Properties
        .PolicyDocument.Statement,
    );
    const puts = statements.filter((s) => s.Action === "s3:PutObject");
    expect(puts).toHaveLength(1);
    expect(JSON.stringify(puts[0]?.Resource)).toContain("/feeds/*");
  });
});
