/**
 * S3 client singleton — same lazy-per-container pattern as the DocumentClient
 * in db.ts. Used by the telemetry sink (and any future direct S3 writers).
 */
import { S3Client } from "@aws-sdk/client-s3";

let s3Client: S3Client | undefined;

/** Lazily-created S3Client shared across warm Lambda invocations. */
export function getS3Client(): S3Client {
  if (!s3Client) {
    s3Client = new S3Client({ region: process.env.AWS_REGION ?? "us-east-1" });
  }
  return s3Client;
}
