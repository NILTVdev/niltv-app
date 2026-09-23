/**
 * GET /v1/home — the composed Home read (design §4.1, §6.1): hero from the
 * active event plus the ambassadors rail and one content rail per channel
 * that carries clips, in one CloudFront-cacheable object — one spinner per
 * screen, one cacheable object per screen.
 */
import { BatchGetCommand, GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { type ContentCard, HomeResponse, type Rail } from "@niltv/types";
import type { APIGatewayProxyHandlerV2 } from "aws-lambda";
import {
  ATHLETE_PK_PREFIX,
  CHANNEL_PK_PREFIX,
  EVENTS_ALL_GSI1PK,
  GSI1,
  PROFILES_ALL_GSI1PK,
  channelContentGsi1Pk,
  channelKey,
  configKey,
  getDocClient,
  profileKey,
} from "../lib/db";
import { forbidden, json } from "../lib/http";
import { requireOriginVerify } from "../lib/origin";
import {
  ambassadorChips,
  type Item,
  resolveEventMedia,
  resolveThumbUrl,
  selectHero,
  toContentCard,
} from "../lib/shape";

/**
 * Content rails on Home: newest-N per channel via GSI1 desc (spec §5.2).
 * The network sources first, then the channel rails: TrueBlue TV leads,
 * followed by the three campus channels that railed at launch. The client
 * hides empty rails.
 *
 * The other roster channels are not railed here. When one is added, respect
 * the web hide lists (build-sections.py SLIDER_REMOVED + GRID_REMOVED): a
 * channel hidden there stays off Home too. The Channels tab's Coming Soon
 * rule does not read these rails: it reads clipCount from /v1/channels.
 */
const CONTENT_RAILS = [
  { key: "featured", title: "Featured", channelId: "ch-niltv", limit: 6 },
  { key: "nilstar", title: "NIL Star", channelId: "ch-nilstar", limit: 8 },
  { key: "trueblue", title: "TrueBlue TV", channelId: "ch-truebluetv", limit: 8 },
  { key: "dorecity", title: "Dore City TV", channelId: "ch-dorecitytv", limit: 8 },
  { key: "chapelhill", title: "Chapel Hill TV", channelId: "ch-chapelhilltv", limit: 8 },
  { key: "starkville", title: "Starkville TV", channelId: "ch-starkvilletv", limit: 8 },
] as const;

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  // Origin lockdown: only CloudFront (which injects x-origin-verify) may call.
  if (!requireOriginVerify(event)) return forbidden();

  const db = getDocClient();
  const table = process.env.TABLE_NAME ?? "";

  const queryGsi1 = (pk: string, limit?: number, newestFirst = false) =>
    db.send(
      new QueryCommand({
        TableName: table,
        IndexName: GSI1,
        KeyConditionExpression: "GSI1PK = :pk",
        ExpressionAttributeValues: { ":pk": pk },
        ScanIndexForward: !newestFirst,
        ...(limit !== undefined ? { Limit: limit } : {}),
      }),
    );

  // Wave 1 — every base read in parallel (rails fan out per CONTENT_RAILS).
  const [configOut, eventsOut, profilesOut, railsOut] = await Promise.all([
    db.send(new GetCommand({ TableName: table, Key: configKey() })),
    queryGsi1(EVENTS_ALL_GSI1PK),
    queryGsi1(PROFILES_ALL_GSI1PK),
    Promise.all(
      CONTENT_RAILS.map((rail) => queryGsi1(channelContentGsi1Pk(rail.channelId), rail.limit, true)),
    ),
  ]);

  const activeEventId =
    typeof configOut.Item?.["activeEventId"] === "string" ? (configOut.Item["activeEventId"] as string) : null;
  // Media resolution before hero selection so the billboard carries its reel/art.
  const hero = selectHero(
    activeEventId,
    ((eventsOut.Items ?? []) as Item[]).map(resolveEventMedia),
  );
  const chips = ambassadorChips((profilesOut.Items ?? []) as Item[]);
  const railItems = railsOut.map((out) => (out.Items ?? []) as Item[]);

  // Wave 2 — resolve channel + creator attribution for every card in one
  // BatchGet: one channel item per CONTENT_RAILS entry plus each distinct
  // creator profile.
  const creatorIds = new Set<string>();
  for (const items of railItems) {
    for (const item of items) {
      if (typeof item["athleteId"] === "string") creatorIds.add(item["athleteId"]);
    }
  }
  const batchOut = await db.send(
    new BatchGetCommand({
      RequestItems: {
        [table]: {
          Keys: [
            ...CONTENT_RAILS.map((rail) => channelKey(rail.channelId)),
            ...[...creatorIds].map((id) => profileKey(id)),
          ],
        },
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

  const rails: Rail[] = [
    { kind: "athletes", key: "ambassadors", title: "Featured Ambassadors", items: chips },
    ...CONTENT_RAILS.map(
      (rail, i): Rail => ({
        kind: "content",
        key: rail.key,
        title: rail.title,
        items: (railItems[i] ?? [])
          .map((item) => toContentCard({ ...item, thumbUrl: resolveThumbUrl(item) }, channelsById, profilesById))
          .filter((card): card is ContentCard => card !== undefined),
      }),
    ),
  ];

  const body = HomeResponse.parse({ hero, rails });
  return json(200, body, "public, max-age=60");
};
