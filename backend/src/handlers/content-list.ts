/**
 * GET /v1/content?channelId=&cursor=&limit= — the Watch grid pager (design
 * §4.1): one channel's published clips via GSI1, newest first, with an opaque
 * base64url cursor over DynamoDB's LastEvaluatedKey. Alternatively
 * ?athleteId= pages one creator's clips via the sparse GSI2 creator index
 * (the profile screen's infinite Content grid — the profile endpoint itself
 * returns only the first dozen). Exactly one of channelId/athleteId is
 * required; limit defaults to 24 and caps at 48 (two grid pages).
 */
import { BatchGetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { ApiError, type ContentCard, ContentListResponse } from "@niltv/types";
import type {
  APIGatewayProxyHandlerV2,
  APIGatewayProxyStructuredResultV2,
} from "aws-lambda";
import {
  ATHLETE_PK_PREFIX,
  CHANNEL_PK_PREFIX,
  GSI1,
  GSI2,
  athleteGsiPk,
  channelContentGsi1Pk,
  channelKey,
  getDocClient,
  profileKey,
} from "../lib/db";
import { forbidden, json } from "../lib/http";
import { requireOriginVerify } from "../lib/origin";
import { decodeCursor, encodeCursor, type Item, resolveThumbUrl, toContentCard } from "../lib/shape";

const DEFAULT_LIMIT = 24;
const MAX_LIMIT = 48;

const invalidParam = (message: string): APIGatewayProxyStructuredResultV2 =>
  json(400, ApiError.parse({ error: "INVALID_PARAM", message }));

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  // Origin lockdown: only CloudFront (which injects x-origin-verify) may call.
  if (!requireOriginVerify(event)) return forbidden();

  const channelId = event.queryStringParameters?.["channelId"];
  const athleteId = event.queryStringParameters?.["athleteId"];
  if (!channelId && !athleteId) return invalidParam("channelId or athleteId is required");
  if (channelId && athleteId) return invalidParam("pass channelId or athleteId, not both");

  const rawLimit = event.queryStringParameters?.["limit"];
  let limit = DEFAULT_LIMIT;
  if (rawLimit !== undefined) {
    const parsed = Number.parseInt(rawLimit, 10);
    if (Number.isNaN(parsed) || parsed < 1) return invalidParam("limit must be a positive integer");
    limit = Math.min(parsed, MAX_LIMIT);
  }

  const rawCursor = event.queryStringParameters?.["cursor"];
  const exclusiveStartKey = decodeCursor(rawCursor);
  if (rawCursor !== undefined && exclusiveStartKey === undefined) {
    return invalidParam("cursor is not a valid page cursor");
  }

  const db = getDocClient();
  const table = process.env.TABLE_NAME ?? "";

  // Both index partitions are sparse — only published, rights-cleared clips
  // (seed/publish rule) — so this query alone is the published gate for the
  // grid. channelId walks GSI1; athleteId walks the GSI2 creator index.
  let page;
  try {
    page = await db.send(
      new QueryCommand({
        TableName: table,
        IndexName: channelId ? GSI1 : GSI2,
        KeyConditionExpression: channelId ? "GSI1PK = :pk" : "GSI2PK = :pk",
        ExpressionAttributeValues: {
          ":pk": channelId ? channelContentGsi1Pk(channelId) : athleteGsiPk(athleteId as string),
        },
        ScanIndexForward: false,
        Limit: limit,
        ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      }),
    );
  } catch (err) {
    // A cursor can base64url-decode to well-formed JSON yet still be invalid
    // for this index (minted against another stage, or before a key-schema
    // change). DynamoDB rejects it with ValidationException at query time —
    // that is the caller's bad cursor, not a server fault.
    if (
      exclusiveStartKey &&
      (err as { name?: string }).name === "ValidationException"
    ) {
      return invalidParam("cursor is not a valid page cursor");
    }
    throw err;
  }
  const rows = (page.Items ?? []) as Item[];

  // Resolve channel + creator attribution for the cards in one BatchGet.
  // A creator's clips can span channels, so channel keys come from the rows.
  const channelsById = new Map<string, Item>();
  const profilesById = new Map<string, Item>();
  if (rows.length > 0) {
    const creatorIds = new Set<string>();
    const channelIds = new Set<string>(channelId ? [channelId] : []);
    for (const row of rows) {
      if (typeof row["athleteId"] === "string") creatorIds.add(row["athleteId"]);
      if (typeof row["channelId"] === "string") channelIds.add(row["channelId"]);
    }
    const batchOut = await db.send(
      new BatchGetCommand({
        RequestItems: {
          [table]: {
            Keys: [
              ...[...channelIds].map((id) => channelKey(id)),
              ...[...creatorIds].map((id) => profileKey(id)),
            ],
          },
        },
      }),
    );
    for (const item of (batchOut.Responses?.[table] ?? []) as Item[]) {
      const pk = String(item["PK"]);
      if (pk.startsWith(CHANNEL_PK_PREFIX)) channelsById.set(String(item["id"]), item);
      else if (pk.startsWith(ATHLETE_PK_PREFIX)) profilesById.set(String(item["id"]), item);
    }
  }

  const cursor = encodeCursor(page.LastEvaluatedKey);
  const body = ContentListResponse.parse({
    items: rows
      .map((row) => toContentCard({ ...row, thumbUrl: resolveThumbUrl(row) }, channelsById, profilesById))
      .filter((card): card is ContentCard => card !== undefined),
    ...(cursor !== undefined ? { cursor } : {}),
  });
  return json(200, body, "public, max-age=60");
};
