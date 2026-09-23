/**
 * GET /admin/content/{id}/status (staff) — the transcode state the dashboard
 * polls while a master moves through the §6.8 pipeline:
 * uploading → processing → ready → published (or failed + transcodeError).
 *
 * Response shape: AdminContentStatusResponse from the shared contract (the
 * admin tool polls it with the same schema).
 */
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { AdminContentStatusResponse } from "@niltv/types";
import type { APIGatewayProxyHandlerV2WithJWTAuthorizer } from "aws-lambda";
import { contentKey, getDocClient } from "../../lib/db";
import { forbidden, json, notFound } from "../../lib/http";
import { requireStaff } from "./authz";

export const handler: APIGatewayProxyHandlerV2WithJWTAuthorizer = async (event) => {
  if (!requireStaff(event)) return forbidden();

  const contentId = event.pathParameters?.["id"];
  if (!contentId) return notFound();

  const { Item: row } = await getDocClient().send(
    new GetCommand({
      TableName: process.env.TABLE_NAME ?? "",
      Key: contentKey(contentId),
    }),
  );
  if (!row) return notFound();

  return json(
    200,
    AdminContentStatusResponse.parse({
      transcodeStatus: row["transcodeStatus"],
      transcodeError: row["transcodeError"],
      playbackPath: row["playbackPath"],
      durationSec: row["durationSec"],
    }),
  );
};
