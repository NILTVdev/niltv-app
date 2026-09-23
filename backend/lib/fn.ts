import { Duration, RemovalPolicy } from "aws-cdk-lib";
import { Architecture, Runtime } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import type { Construct } from "constructs";

export interface MakeFnProps {
  stage: string;
  /** Short function name — the deployed name becomes `niltv-{stage}-{name}`. */
  name: string;
  /** Absolute path to the handler entry file (must export `handler`). */
  entry: string;
  env?: Record<string, string>;
  /** Override the 256 MB default (e.g. the ingest Lambda buffers video files). */
  memorySize?: number;
  /** Override the 10s default (long-running scheduled jobs). */
  timeout?: Duration;
}

/**
 * Shared NodejsFunction factory: every Lambda gets an explicit CloudWatch log
 * group (`/aws/lambda/niltv-{stage}-{name}`, 1-month retention, destroyed with
 * the stack in dev, retained elsewhere) plus sane defaults (ARM64, 256 MB,
 * 10s timeout, minified bundle). All handlers — current and future — go
 * through here so they inherit the pattern.
 */
export function makeFn(scope: Construct, id: string, props: MakeFnProps): NodejsFunction {
  const { stage, name, entry, env, memorySize, timeout } = props;

  const logGroup = new logs.LogGroup(scope, `${id}LogGroup`, {
    logGroupName: `/aws/lambda/niltv-${stage}-${name}`,
    retention: logs.RetentionDays.ONE_MONTH,
    removalPolicy: stage === "dev" ? RemovalPolicy.DESTROY : RemovalPolicy.RETAIN,
  });

  return new NodejsFunction(scope, id, {
    functionName: `niltv-${stage}-${name}`,
    entry,
    handler: "handler",
    runtime: Runtime.NODEJS_22_X,
    architecture: Architecture.ARM_64,
    memorySize: memorySize ?? 256,
    timeout: timeout ?? Duration.seconds(10),
    bundling: { minify: true },
    logGroup,
    environment: env,
  });
}
