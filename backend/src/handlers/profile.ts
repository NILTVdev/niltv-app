/**
 * GET /v1/profiles/{athleteId} — person profile + their content in one read
 * (design §4.1). Content comes from the sparse GSI2 creator index (published,
 * rights-cleared clips only); the nilstarVotes stat is summed live from the
 * athlete's ENTRY rows on GSI1 (GSI1PK ATHLETE#{id}, GSI1SK ENTRY#{eventId} —
 * the same partition also mirrors follow rows as USER#{id}, so the ENTRY#
 * prefix isolates competition runs).
 */
import { BatchGetCommand, GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { type ContentCard, ProfileResponse } from "@niltv/types";
import type { APIGatewayProxyHandlerV2 } from "aws-lambda";
import {
  ENTRY_SK_PREFIX,
  GSI1,
  GSI2,
  athleteGsiPk,
  channelKey,
  getDocClient,
  profileKey,
} from "../lib/db";
import { forbidden, json, notFound } from "../lib/http";
import { requireOriginVerify } from "../lib/origin";
import { type Item, resolveThumbUrl, toContentCard } from "../lib/shape";

const CONTENT_LIMIT = 12;

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  // Origin lockdown: only CloudFront (which injects x-origin-verify) may call.
  if (!requireOriginVerify(event)) return forbidden();

  const athleteId = event.pathParameters?.["athleteId"];
  if (!athleteId) return notFound();

  const db = getDocClient();
  const table = process.env.TABLE_NAME ?? "";

  const [profileOut, contentOut, entriesOut] = await Promise.all([
    db.send(new GetCommand({ TableName: table, Key: profileKey(athleteId) })),
    db.send(
      new QueryCommand({
        TableName: table,
        IndexName: GSI2,
        KeyConditionExpression: "GSI2PK = :pk",
        ExpressionAttributeValues: { ":pk": athleteGsiPk(athleteId) },
        ScanIndexForward: false,
        Limit: CONTENT_LIMIT,
      }),
    ),
    db.send(
      new QueryCommand({
        TableName: table,
        IndexName: GSI1,
        KeyConditionExpression: "GSI1PK = :pk AND begins_with(GSI1SK, :entry)",
        ExpressionAttributeValues: { ":pk": athleteGsiPk(athleteId), ":entry": ENTRY_SK_PREFIX },
      }),
    ),
  ]);

  const profile = profileOut.Item as Item | undefined;
  if (!profile) return notFound();

  // Counters are display, facts are truth (design §5) — but for a profile
  // stat the frozen per-entry counters are exactly the published tallies.
  const nilstarVotes = ((entriesOut.Items ?? []) as Item[]).reduce(
    (sum, entry) => sum + (typeof entry["votes"] === "number" ? entry["votes"] : 0),
    0,
  );

  // Resolve the channels of their clips for card attribution; the creator on
  // every card is this profile itself.
  const contentRows = (contentOut.Items ?? []) as Item[];
  const channelsById = new Map<string, Item>();
  const channelIds = [
    ...new Set(contentRows.map((row) => row["channelId"]).filter((id): id is string => typeof id === "string")),
  ];
  if (channelIds.length > 0) {
    const batchOut = await db.send(
      new BatchGetCommand({
        RequestItems: { [table]: { Keys: channelIds.map((id) => channelKey(id)) } },
      }),
    );
    for (const item of (batchOut.Responses?.[table] ?? []) as Item[]) {
      channelsById.set(String(item["id"]), item);
    }
  }
  const profilesById = new Map<string, Item>([[String(profile["id"]), profile]]);

  const body = ProfileResponse.parse({
    id: profile["id"],
    name: profile["name"],
    handle: profile["handle"],
    school: profile["school"],
    sport: profile["sport"],
    bio: profile["bio"] ?? "",
    statuses: profile["statuses"] ?? ["athlete"],
    ambassadorRank: profile["ambassadorRank"],
    avatarUrl: profile["avatarUrl"],
    coverUrl: profile["coverUrl"],
    stats: {
      followers: profile["followers"] ?? 0,
      views: profile["totalViews"] ?? 0,
      nilstarVotes,
    },
    socials: profile["socials"] ?? [],
    brands: profile["brands"] ?? [],
    content: contentRows
      .map((row) => toContentCard({ ...row, thumbUrl: resolveThumbUrl(row) }, channelsById, profilesById))
      .filter((card): card is ContentCard => card !== undefined),
  });
  return json(200, body, "public, max-age=60");
};
