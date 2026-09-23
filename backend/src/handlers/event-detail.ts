/**
 * GET /v1/events/{eventId} — event + finalists in one read (design §4.1).
 * Entry order is server-rotated by the current UTC minute for bias-free
 * display (spec §5.4); the frozen recap rides along when the transition
 * Lambda has stamped one onto the event item (design §6.5).
 */
import { BatchGetCommand, GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { type EntryDetail, EventDetailResponse } from "@niltv/types";
import type { APIGatewayProxyHandlerV2 } from "aws-lambda";
import { ENTRY_SK_PREFIX, eventKey, getDocClient, profileKey } from "../lib/db";
import { forbidden, json, notFound } from "../lib/http";
import { requireOriginVerify } from "../lib/origin";
import { type Item, resolveEventMedia, rotateByMinute, toEntryDetail } from "../lib/shape";

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  // Origin lockdown: only CloudFront (which injects x-origin-verify) may call.
  if (!requireOriginVerify(event)) return forbidden();

  const eventId = event.pathParameters?.["eventId"];
  if (!eventId) return notFound();

  const db = getDocClient();
  const table = process.env.TABLE_NAME ?? "";

  const [metaOut, entriesOut] = await Promise.all([
    db.send(new GetCommand({ TableName: table, Key: eventKey(eventId) })),
    db.send(
      new QueryCommand({
        TableName: table,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :entry)",
        ExpressionAttributeValues: { ":pk": eventKey(eventId).PK, ":entry": ENTRY_SK_PREFIX },
      }),
    ),
  ]);

  const meta = metaOut.Item as Item | undefined;
  if (!meta) return notFound();
  const entryRows = (entriesOut.Items ?? []) as Item[];

  // Resolve each finalist's athlete profile (name/school/sport/bio) in one BatchGet.
  const athleteIds = [...new Set(entryRows.map((row) => String(row["athleteId"])))];
  const profilesById = new Map<string, Item>();
  if (athleteIds.length > 0) {
    const batchOut = await db.send(
      new BatchGetCommand({
        RequestItems: { [table]: { Keys: athleteIds.map((id) => profileKey(id)) } },
      }),
    );
    for (const item of (batchOut.Responses?.[table] ?? []) as Item[]) {
      profilesById.set(String(item["id"]), item);
    }
  }

  const entries = entryRows
    .map((row) => toEntryDetail(row, profilesById))
    .filter((entry): entry is EntryDetail => entry !== undefined);

  const body = EventDetailResponse.parse({
    // Event media (intro reel + showcase) is stored as bucket paths — compose
    // the CDN URLs here so the stored row stays stage-agnostic (design §6.8).
    event: resolveEventMedia(meta),
    entries: rotateByMinute(entries, new Date().getUTCMinutes()),
    ...(meta["recap"] !== undefined ? { recap: meta["recap"] } : {}),
  });
  return json(200, body, "public, max-age=30");
};
