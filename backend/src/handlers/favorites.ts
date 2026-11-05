/** PUT /v1/me/favorites (JWT) — replace saved school, sport and channel preferences. */
import { BatchGetCommand, GetCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { MeFavoritesPutRequest } from "@niltv/types";
import type { APIGatewayProxyHandlerV2WithJWTAuthorizer } from "aws-lambda";
import { channelKey, configKey, getDocClient, userKey } from "../lib/db";
import { channelIdsFromConfig } from "../lib/channel-catalog";
import { badRequest, forbidden, json, notFound, parseJsonBody, unauthorized } from "../lib/http";
import { requireOriginVerify } from "../lib/origin";
import { type Item, mapUserPartition } from "../lib/shape";

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function normalizeFavorites(input: MeFavoritesPutRequest): MeFavoritesPutRequest {
  const schools = new Map<string, string>();
  for (const school of input.schools) {
    const key = school.toLowerCase();
    if (!schools.has(key)) schools.set(key, school);
  }
  return {
    schools: [...schools.values()],
    sports: unique(input.sports),
    channels: unique(input.channels),
  };
}

export const handler: APIGatewayProxyHandlerV2WithJWTAuthorizer = async (event) => {
  if (!requireOriginVerify(event)) return forbidden();

  const sub = event.requestContext?.authorizer?.jwt?.claims?.["sub"];
  if (typeof sub !== "string" || sub.length === 0) return unauthorized();

  const request = MeFavoritesPutRequest.safeParse(parseJsonBody(event.body, event.isBase64Encoded === true));
  if (!request.success) return badRequest();

  const db = getDocClient();
  const table = process.env.TABLE_NAME ?? "";
  const favorites = normalizeFavorites(request.data);

  if (favorites.channels.length > 0) {
    const { Item: config } = await db.send(new GetCommand({ TableName: table, Key: configKey() }));
    const activeChannels = channelIdsFromConfig(config);
    if (favorites.channels.some((id) => !activeChannels.includes(id))) return badRequest();

    const result = await db.send(
      new BatchGetCommand({
        RequestItems: {
          [table]: { Keys: favorites.channels.map((id) => channelKey(id)) },
        },
      }),
    );
    const unprocessed = result.UnprocessedKeys?.[table]?.Keys;
    if (unprocessed && unprocessed.length > 0) throw new Error("Unprocessed channel catalog keys");

    const found = new Set(
      ((result.Responses?.[table] ?? []) as Item[]).map((item) => String(item["id"])),
    );
    if (favorites.channels.some((id) => !found.has(id))) return badRequest();
  }

  try {
    await db.send(
      new UpdateCommand({
        TableName: table,
        Key: userKey(sub),
        ConditionExpression: "attribute_exists(PK)",
        UpdateExpression: "SET favorites = :favorites",
        ExpressionAttributeValues: { ":favorites": favorites },
      }),
    );
  } catch (err) {
    if (
      typeof err === "object" &&
      err !== null &&
      (err as { name?: string }).name === "ConditionalCheckFailedException"
    ) {
      return notFound();
    }
    throw err;
  }

  const rows: Item[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await db.send(
      new QueryCommand({
        TableName: table,
        KeyConditionExpression: "PK = :pk",
        ExpressionAttributeValues: { ":pk": userKey(sub).PK },
        ConsistentRead: true,
        ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      }),
    );
    rows.push(...((page.Items ?? []) as Item[]));
    exclusiveStartKey = page.LastEvaluatedKey;
  } while (exclusiveStartKey);

  const body = mapUserPartition(sub, rows);
  if (!body) return notFound();
  return json(200, body, "private, no-store");
};