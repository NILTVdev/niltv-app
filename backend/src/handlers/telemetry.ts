/**
 * POST /v1/telemetry — batched client events → S3 directly (design §11:
 * deliberately dumb storage; Athena reads the day-partitioned files). Each
 * accepted batch lands as one gzip NDJSON object under
 * telemetry/yyyy/MM/dd/{uuid}.ndjson.gz.
 *
 * Direct S3 instead of Firehose: this AWS account's activation state blocks
 * Firehose (SubscriptionRequiredException — same as MediaConvert), and at MVP
 * volume one object per batch is simpler and cheaper anyway.
 *
 * Public route: telemetry is accepted anonymously (design §4.1), so there is
 * no JWT to attribute — events are enriched with receivedAt only. Delivery is
 * fire-and-forget from the client's view: analytics must never break the app.
 */
import { randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { ApiError, TelemetryBatchRequest } from "@niltv/types";
import type { APIGatewayProxyHandlerV2 } from "aws-lambda";
import { forbidden, json } from "../lib/http";
import { requireOriginVerify } from "../lib/origin";
import { getS3Client } from "../lib/s3";

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  // Origin lockdown: only CloudFront (which injects x-origin-verify) may call.
  if (!requireOriginVerify(event)) return forbidden();

  let batch: TelemetryBatchRequest;
  try {
    batch = TelemetryBatchRequest.parse(JSON.parse(event.body ?? ""));
  } catch {
    return json(400, ApiError.parse({ error: "INVALID_BODY" }));
  }

  if (batch.events.length > 0) {
    const receivedAt = new Date().toISOString();
    const day = receivedAt.slice(0, 10).replaceAll("-", "/");
    const ndjson = batch.events
      .map((telemetryEvent) => JSON.stringify({ ...telemetryEvent, receivedAt }))
      .join("\n");
    try {
      await getS3Client().send(
        new PutObjectCommand({
          Bucket: process.env.ANALYTICS_BUCKET ?? "",
          Key: `telemetry/${day}/${randomUUID()}.ndjson.gz`,
          Body: gzipSync(Buffer.from(`${ndjson}\n`, "utf8")),
          ContentType: "application/x-ndjson",
          ContentEncoding: "gzip",
        }),
      );
    } catch (err) {
      // Log for the ops alarm trail, still 202 — analytics never breaks the app.
      console.error(`telemetry: S3 write failed for ${batch.events.length} events`, err);
    }
  }

  return json(202, { status: "ok" });
};
