/**
 * POST /admin/content/{id}/publish · /unpublish (staff) — THE publish gate
 * (design §6.8): a row goes live only when the transcode pipeline reports
 * "ready" AND staff has confirmed NIL/likeness rights (design §10:
 * rightsConfirmed is the operational rights gate). Both preconditions are
 * enforced atomically as a ConditionExpression — never read-then-write.
 *
 * Publishing stamps publishedAt and materializes the sparse GSI rows
 * (GSI1: CHANNEL#{channelId}/publishedAt → Watch grids; GSI2:
 * ATHLETE#{athleteId}/publishedAt → creator attribution) — mirroring
 * scripts/seed.ts exactly: only published, rights-cleared clips ever carry
 * GSI keys, so unplayable rows can never appear in public grids. The write
 * also fires the DynamoDB Stream → push fanout (§6.4).
 *
 * After a publish the GSI3 syndication index is stamped from the same rule
 * every partner surface uses (lib/syndication): a row tagged owned/licensed
 * becomes a partner candidate the moment it goes live, and nothing else
 * does. Unpublish reverses everything: REMOVE publishedAt + all six GSI
 * attributes, transcodeStatus back to "ready" (only a published row can be
 * unpublished).
 */
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { AdminPublishResponse } from "@niltv/types";
import type { APIGatewayProxyHandlerV2WithJWTAuthorizer } from "aws-lambda";
import { z } from "zod";
import { channelContentGsi1Pk, contentKey, getDocClient, profileKey } from "../../lib/db";
import { forbidden, json, notFound } from "../../lib/http";
import type { Item } from "../../lib/shape";
import { stampSyndicationIndex } from "../../lib/syndication-index";
import { requireStaff } from "./authz";
import { conflict, isConditionalCheckFailed } from "./util";

/** Ack for unpublish — dashboard-only, hence composed locally (publish returns the contract's AdminPublishResponse). */
const AdminUnpublishResponse = z.object({ status: z.literal("unpublished") });

/** Human diagnosis of WHICH §6.8 precondition blocked a publish, from a row snapshot. */
export function publishBlockedReason(row: Record<string, unknown>): string {
  const reasons: string[] = [];
  const status = row["transcodeStatus"];
  if (status === "published") {
    reasons.push("content is already published");
  } else if (status !== "ready") {
    reasons.push(`transcode is not ready (status: ${String(status ?? "unknown")})`);
  }
  if (row["rightsConfirmed"] !== true) {
    reasons.push("rightsConfirmed is not set — confirm NIL/likeness rights first");
  }
  // The condition can also fail on a race between our read and the write.
  return reasons.length > 0 ? reasons.join("; ") : "publish preconditions not met (row changed concurrently — retry)";
}

export const handler: APIGatewayProxyHandlerV2WithJWTAuthorizer = async (event) => {
  if (!requireStaff(event)) return forbidden();

  const contentId = event.pathParameters?.["id"];
  if (!contentId) return notFound();

  const path = event.rawPath ?? event.requestContext?.http?.path ?? "";
  const action = path.endsWith("/unpublish") ? "unpublish" : path.endsWith("/publish") ? "publish" : undefined;
  if (action === undefined) return notFound();

  const db = getDocClient();
  const table = process.env.TABLE_NAME ?? "";

  // Read the row first: publish needs channelId/athleteId for the GSI keys,
  // and both actions use the snapshot to diagnose a tripped condition. The
  // GATE itself never trusts this read — it re-checks via ConditionExpression.
  const { Item: row } = await db.send(
    new GetCommand({ TableName: table, Key: contentKey(contentId) }),
  );
  if (!row) return notFound();

  if (action === "publish") {
    const publishedAt = new Date().toISOString();
    let published;
    try {
      published = await db.send(
        new UpdateCommand({
          TableName: table,
          Key: contentKey(contentId),
          // The gate (design §6.8): ready AND rights confirmed, atomically.
          ConditionExpression: "#transcodeStatus = :ready AND #rightsConfirmed = :confirmed",
          UpdateExpression:
            "SET #transcodeStatus = :published, #publishedAt = :publishedAt, " +
            "GSI1PK = :gsi1pk, GSI1SK = :publishedAt, GSI2PK = :gsi2pk, GSI2SK = :publishedAt",
          ExpressionAttributeNames: {
            "#transcodeStatus": "transcodeStatus",
            "#rightsConfirmed": "rightsConfirmed",
            "#publishedAt": "publishedAt",
          },
          ExpressionAttributeValues: {
            ":ready": "ready",
            ":confirmed": true,
            ":published": "published",
            ":publishedAt": publishedAt,
            ":gsi1pk": channelContentGsi1Pk(String(row["channelId"])),
            ":gsi2pk": profileKey(String(row["athleteId"])).PK, // ATHLETE#{athleteId}
          },
          ReturnValues: "ALL_NEW",
        }),
      );
    } catch (err) {
      if (isConditionalCheckFailed(err)) {
        return conflict("NOT_READY", publishBlockedReason(row));
      }
      throw err;
    }
    await stampSyndicationIndex((published.Attributes ?? { ...row, publishedAt, transcodeStatus: "published" }) as Item);
    return json(200, AdminPublishResponse.parse({ status: "published", publishedAt }));
  }

  // ── unpublish ──────────────────────────────────────────────────────────
  try {
    await db.send(
      new UpdateCommand({
        TableName: table,
        Key: contentKey(contentId),
        // Only a published row can be unpublished — never promote an
        // uploading/processing/failed row to "ready" by side effect.
        ConditionExpression: "#transcodeStatus = :published",
        UpdateExpression:
          "SET #transcodeStatus = :ready REMOVE #publishedAt, GSI1PK, GSI1SK, GSI2PK, GSI2SK, GSI3PK, GSI3SK",
        ExpressionAttributeNames: {
          "#transcodeStatus": "transcodeStatus",
          "#publishedAt": "publishedAt",
        },
        ExpressionAttributeValues: {
          ":published": "published",
          ":ready": "ready",
        },
      }),
    );
  } catch (err) {
    if (isConditionalCheckFailed(err)) {
      return conflict(
        "NOT_READY",
        `content is not published (status: ${String(row["transcodeStatus"] ?? "unknown")})`,
      );
    }
    throw err;
  }
  return json(200, AdminUnpublishResponse.parse({ status: "unpublished" }));
};
