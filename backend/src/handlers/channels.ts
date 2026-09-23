/**
 * GET /v1/channels — the content properties (design §4.1). The CONFIG item's
 * channelIds attribute is the curated list (the ops panel adds/removes/orders
 * channels without a deploy); absent, the launch trio serves as the fallback
 * so the Watch tab never renders empty because config is mid-edit. Each
 * channel carries clipCount, so the Channels tab applies the web's Coming
 * Soon floor without a Home dependency.
 */
import { BatchGetCommand, GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { Channel, ChannelsResponse } from "@niltv/types";
import type { APIGatewayProxyHandlerV2 } from "aws-lambda";
import { GSI1, channelContentGsi1Pk, channelKey, configKey, getDocClient } from "../lib/db";
import { forbidden, json } from "../lib/http";
import { requireOriginVerify } from "../lib/origin";
import type { Item } from "../lib/shape";

/** Launch channels (fixtures) — used when CONFIG carries no channelIds. */
const FALLBACK_CHANNEL_IDS = ["ch-trueblue", "ch-niltv"] as const;

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  // Origin lockdown: only CloudFront (which injects x-origin-verify) may call.
  if (!requireOriginVerify(event)) return forbidden();

  const db = getDocClient();
  const table = process.env.TABLE_NAME ?? "";

  const { Item: config } = await db.send(new GetCommand({ TableName: table, Key: configKey() }));
  const configured = config?.["channelIds"];
  const channelIds: readonly string[] =
    Array.isArray(configured) && configured.length > 0 && configured.every((id) => typeof id === "string")
      ? (configured as string[])
      : FALLBACK_CHANNEL_IDS;

  const batchOut = await db.send(
    new BatchGetCommand({
      RequestItems: { [table]: { Keys: channelIds.map((id) => channelKey(id)) } },
    }),
  );

  // BatchGet returns in arbitrary order — re-impose the configured order and
  // skip dangling ids rather than failing the whole list.
  const byId = new Map<string, Item>();
  for (const item of (batchOut.Responses?.[table] ?? []) as Item[]) {
    byId.set(String(item["id"]), item);
  }

  // Published clips per channel: one GSI1 COUNT per channel, run in parallel.
  // GSI1's CHANNEL# partition is the channel's published clips (db.ts); a
  // draft or a tombstone carries no GSI keys, so neither counts. COUNT still
  // pages at 1 MB scanned, so the pages are summed.
  const countClips = async (id: string): Promise<number> => {
    let total = 0;
    let exclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const page = await db.send(
        new QueryCommand({
          TableName: table,
          IndexName: GSI1,
          KeyConditionExpression: "GSI1PK = :pk",
          ExpressionAttributeValues: { ":pk": channelContentGsi1Pk(id) },
          Select: "COUNT",
          ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
        }),
      );
      total += page.Count ?? 0;
      exclusiveStartKey = page.LastEvaluatedKey;
    } while (exclusiveStartKey);
    return total;
  };

  const channels = await Promise.all(
    channelIds
      .map((id) => byId.get(id))
      .filter((item): item is Item => item !== undefined)
      .map(async (item) => Channel.parse({ ...item, clipCount: await countClips(String(item["id"])) })),
  );

  return json(200, ChannelsResponse.parse({ channels }), "public, max-age=300");
};
