/**
 * GET /admin/channels (staff) — the content properties for the dashboard's
 * channel dropdowns. Mirrors the public /v1/channels source of truth: the
 * CONFIG#app `channelIds` list (which the social-ingest bridge appends new
 * campus channels to), falling back to the seed trio when unset.
 */
import { BatchGetCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import { Channel, ChannelsResponse } from "@niltv/types";
import type { APIGatewayProxyHandlerV2WithJWTAuthorizer } from "aws-lambda";
import { channelKey, configKey, getDocClient } from "../../lib/db";
import { forbidden, json } from "../../lib/http";
import { requireStaff } from "./authz";

/** The seed trio, in display order (matches scripts/seed.ts fixtures). */
const SEED_CHANNEL_IDS = ["ch-trueblue", "ch-niltv"];

export const handler: APIGatewayProxyHandlerV2WithJWTAuthorizer = async (event) => {
  if (!requireStaff(event)) return forbidden();

  const db = getDocClient();
  const table = process.env.TABLE_NAME ?? "";

  const { Item: config } = await db.send(new GetCommand({ TableName: table, Key: configKey() }));
  const configured = config?.["channelIds"];
  const channelIds: readonly string[] =
    Array.isArray(configured) && configured.length > 0 && configured.every((id) => typeof id === "string")
      ? (configured as string[])
      : SEED_CHANNEL_IDS;

  // Well below the 100-key/16MB BatchGet limits; any missing row just drops out.
  const result = await db.send(
    new BatchGetCommand({
      RequestItems: { [table]: { Keys: channelIds.map((id) => channelKey(id)) } },
    }),
  );

  // BatchGet returns items in arbitrary order — restore the display order.
  const byId = new Map<string, Channel>();
  for (const item of result.Responses?.[table] ?? []) {
    const channel = Channel.parse(item);
    byId.set(channel.id, channel);
  }
  const channels = channelIds.flatMap((id) => {
    const channel = byId.get(id);
    return channel ? [channel] : [];
  });

  return json(200, ChannelsResponse.parse({ channels }));
};
