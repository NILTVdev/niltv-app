/**
 * GET /partner/v1/changes?since=<ISO> — the replay path. Everything in the
 * partner's scope whose syndication stamp is at or after `since`, oldest
 * first, including withdrawals as tombstones. A partner that missed a
 * webhook (or never set one up) catches up from here; a partner that never
 * polls anything else can run entirely on this endpoint plus /content/{id}.
 */
import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { type PartnerChange, PartnerChangesResponse } from "@niltv/types";
import type { APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { GSI3, SYND_ALL_GSI3PK, getDocClient } from "../../lib/db";
import { badRequest, forbidden, json, unauthorized } from "../../lib/http";
import { requireOriginVerify } from "../../lib/origin";
import { encodeCursor, type Item } from "../../lib/shape";
import { decodeSyndicationCursor } from "../../lib/syndication-index";
import { partnerScope, syndicationUpdatedAtOf } from "../../lib/syndication";
import { loadPartner, partnerApiDisabled, partnerApiEnabled, partnerIdOf, type PartnerEvent } from "./context";

const PAGE = 200;

/** Which lifecycle event a candidate row represents to a partner polling since `since`. */
export function changeOf(row: Item): PartnerChange | undefined {
  const id = typeof row["id"] === "string" ? row["id"] : undefined;
  if (!id) return undefined;
  const withdrawnAt = row["withdrawnAt"];
  if (typeof withdrawnAt === "string") return { id, type: "content.withdrawn", at: withdrawnAt };
  const at = syndicationUpdatedAtOf(row);
  if (!at) return undefined;
  const publishedAt = typeof row["publishedAt"] === "string" ? row["publishedAt"] : undefined;
  return { id, type: at === publishedAt ? "content.published" : "content.updated", at };
}

export const handler = async (event: PartnerEvent): Promise<APIGatewayProxyStructuredResultV2> => {
  if (!partnerApiEnabled()) return partnerApiDisabled();
  if (!requireOriginVerify(event)) return forbidden();
  const partnerId = partnerIdOf(event);
  if (!partnerId) return unauthorized();
  const partner = await loadPartner(partnerId);
  if (!partner) return unauthorized();

  const q = event.queryStringParameters ?? {};
  const sinceRaw = q["since"];
  if (!sinceRaw || Number.isNaN(Date.parse(sinceRaw))) return badRequest("since (ISO-8601) is required");
  const since = new Date(sinceRaw).toISOString();
  const startKey = q["cursor"] !== undefined ? decodeSyndicationCursor(q["cursor"]) : undefined;
  if (q["cursor"] !== undefined && startKey === undefined) return badRequest("cursor is not valid");

  let out;
  try {
    out = await getDocClient().send(
      new QueryCommand({
        TableName: process.env.TABLE_NAME ?? "",
        IndexName: GSI3,
        KeyConditionExpression: "GSI3PK = :pk AND GSI3SK >= :since",
        ExpressionAttributeValues: { ":pk": SYND_ALL_GSI3PK, ":since": since },
        ScanIndexForward: true,
        Limit: PAGE,
        ExclusiveStartKey: startKey,
      }),
    );
  } catch (err) {
    if (startKey && (err as { name?: string }).name === "ValidationException") return badRequest("cursor is not a valid page cursor");
    throw err;
  }

  const now = new Date();
  const changes: PartnerChange[] = [];
  for (const row of (out.Items ?? []) as Item[]) {
    // Scope only: a withdrawn row is by definition not base-eligible, and
    // that is exactly the row a partner must hear about.
    if (!partnerScope(row, partner, now).eligible) continue;
    const change = changeOf(row);
    if (change) changes.push(change);
  }

  const lastKey = out.LastEvaluatedKey as Record<string, unknown> | undefined;
  return json(
    200,
    PartnerChangesResponse.parse({ since, changes, ...(lastKey ? { cursor: encodeCursor(lastKey) } : {}) }),
    "private, no-store",
  );
};
