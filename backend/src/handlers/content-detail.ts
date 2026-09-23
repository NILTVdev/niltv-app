/**
 * GET /v1/content/{contentId} — clip + creator + related in one read (design
 * §4.1). Unpublished rows (no publishedAt) are invisible here — drafts and
 * still-transcoding clips must never leak. playbackUrl/thumbUrl come from
 * resolvePlaybackUrl/resolveThumbUrl (design §6.8: pipeline rows store paths;
 * the CloudFront domain is composed in at request time); a row with no
 * resolvable playback URL is 404 PLAYBACK_UNAVAILABLE, not a broken player.
 */
import { BatchGetCommand, GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { ApiError, type ContentCard, ContentDetailResponse } from "@niltv/types";
import type { APIGatewayProxyHandlerV2 } from "aws-lambda";
import {
  ATHLETE_PK_PREFIX,
  CHANNEL_PK_PREFIX,
  GSI1,
  channelContentGsi1Pk,
  channelKey,
  contentKey,
  getDocClient,
  profileKey,
} from "../lib/db";
import { forbidden, json, notFound } from "../lib/http";
import { requireOriginVerify } from "../lib/origin";
import {
  type Item,
  resolvePlaybackUrl,
  resolveThumbUrl,
  toAthleteChip,
  toContentCard,
} from "../lib/shape";

const RELATED_LIMIT = 6;

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  // Origin lockdown: only CloudFront (which injects x-origin-verify) may call.
  if (!requireOriginVerify(event)) return forbidden();

  const contentId = event.pathParameters?.["contentId"];
  if (!contentId) return notFound();

  const db = getDocClient();
  const table = process.env.TABLE_NAME ?? "";

  const { Item } = await db.send(new GetCommand({ TableName: table, Key: contentKey(contentId) }));
  const row = Item as Item | undefined;
  // Published gate: a missing publishedAt means draft/processing — 404, same
  // as absent, so unpublished ids are indistinguishable from nonexistent ones.
  if (!row || typeof row["publishedAt"] !== "string" || row["publishedAt"].length === 0) {
    return notFound();
  }

  const playbackUrl = resolvePlaybackUrl(row);
  if (playbackUrl === undefined) {
    return json(404, ApiError.parse({ error: "PLAYBACK_UNAVAILABLE" }));
  }

  const channelId = String(row["channelId"]);
  const creatorId = String(row["athleteId"]);

  // Related: same channel, newest first, excluding this clip. Query one extra
  // so the exclusion still leaves a full rail.
  const relatedOut = await db.send(
    new QueryCommand({
      TableName: table,
      IndexName: GSI1,
      KeyConditionExpression: "GSI1PK = :pk",
      ExpressionAttributeValues: { ":pk": channelContentGsi1Pk(channelId) },
      ScanIndexForward: false,
      Limit: RELATED_LIMIT + 1,
    }),
  );
  const relatedRows = ((relatedOut.Items ?? []) as Item[])
    .filter((item) => item["id"] !== contentId)
    .slice(0, RELATED_LIMIT);

  // One BatchGet resolves the channel plus every creator (this clip's and the
  // related cards').
  const creatorIds = new Set<string>([creatorId]);
  for (const item of relatedRows) {
    if (typeof item["athleteId"] === "string") creatorIds.add(item["athleteId"]);
  }
  const batchOut = await db.send(
    new BatchGetCommand({
      RequestItems: {
        [table]: { Keys: [channelKey(channelId), ...[...creatorIds].map((id) => profileKey(id))] },
      },
    }),
  );
  const channelsById = new Map<string, Item>();
  const profilesById = new Map<string, Item>();
  for (const item of (batchOut.Responses?.[table] ?? []) as Item[]) {
    const pk = String(item["PK"]);
    if (pk.startsWith(CHANNEL_PK_PREFIX)) channelsById.set(String(item["id"]), item);
    else if (pk.startsWith(ATHLETE_PK_PREFIX)) profilesById.set(String(item["id"]), item);
  }

  const channel = channelsById.get(channelId);
  const creator = profilesById.get(creatorId);
  // Dangling channel/creator references — the clip can't render its screen.
  if (!channel || !creator) return notFound();

  const body = ContentDetailResponse.parse({
    id: row["id"],
    title: row["title"],
    description: row["description"] ?? "",
    channelId,
    channelName: channel["name"],
    provider: row["provider"] ?? "hls",
    playbackUrl,
    thumbUrl: resolveThumbUrl(row),
    // transcode-complete stamps durationSec; fixtures/admin rows carry duration.
    duration: row["duration"] ?? row["durationSec"],
    likes: row["likes"] ?? 0,
    creator: toAthleteChip(creator),
    related: relatedRows
      .map((item) => toContentCard({ ...item, thumbUrl: resolveThumbUrl(item) }, channelsById, profilesById))
      .filter((card): card is ContentCard => card !== undefined),
  });
  return json(200, body, "public, max-age=60");
};
