/**
 * POST /admin/content/{id}/upload-url (staff) — presigned single-part S3 PUT
 * for the video master (design §6.8 step 2; multipart comes later if masters
 * outgrow single-part limits).
 *
 * The object lands at masters/{contentId}/master.mp4 — exactly the
 * masters/{contentId}/{filename} shape start-transcode's S3 trigger parses.
 * The filename stays "master.mp4" whatever the declared content type;
 * MediaConvert sniffs the container, and the fixed name keeps re-uploads
 * overwriting rather than accumulating.
 *
 * IAM note: signing needs no S3 permission — the SIGNED URL inherits this
 * function's role at use time, so the role carries s3:PutObject on masters/*
 * (granted in admin-stack.ts) and nothing else.
 */
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { AdminUploadUrlResponse } from "@niltv/types";
import type { APIGatewayProxyHandlerV2WithJWTAuthorizer } from "aws-lambda";
import { z } from "zod";
import { forbidden, json, notFound } from "../../lib/http";
import { requireStaff } from "./authz";
import { badRequest, parseJsonBody } from "./util";

const EXPIRES_IN_SECONDS = 3600;

/** Request body — locally composed; the only admin route with a non-contract body. */
const UploadUrlRequest = z.object({
  contentType: z.string().min(1).default("video/mp4"),
});

let s3Client: S3Client | undefined;

function getS3Client(): S3Client {
  if (!s3Client) {
    s3Client = new S3Client({ region: process.env.AWS_REGION ?? "us-east-1" });
  }
  return s3Client;
}

/** Master object key for a content id — must match start-transcode's parseMasterKey. */
export function masterKey(contentId: string): string {
  return `masters/${contentId}/master.mp4`;
}

export const handler: APIGatewayProxyHandlerV2WithJWTAuthorizer = async (event) => {
  if (!requireStaff(event)) return forbidden();

  const contentId = event.pathParameters?.["id"];
  if (!contentId) return notFound();

  const body = parseJsonBody(event);
  if (body === undefined) return badRequest("request body is not valid JSON");
  const parsed = UploadUrlRequest.safeParse(body);
  if (!parsed.success) return badRequest(parsed.error.issues.map((i) => i.message).join("; "));

  const key = masterKey(contentId);
  const uploadUrl = await getSignedUrl(
    getS3Client(),
    new PutObjectCommand({
      Bucket: process.env.MASTERS_BUCKET ?? "",
      Key: key,
      ContentType: parsed.data.contentType,
    }),
    { expiresIn: EXPIRES_IN_SECONDS },
  );

  return json(
    200,
    AdminUploadUrlResponse.parse({ uploadUrl, key, expiresInSeconds: EXPIRES_IN_SECONDS }),
  );
};
