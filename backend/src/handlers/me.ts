/**
 * GET /v1/me (JWT) — identity plus everything gated UI needs in one call
 * (design §4.1): votes{}, follows[], notification follows, mapped from the
 * full USER#{sub} partition. Never cached (Cache-Control private, no-store).
 */
import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyHandlerV2WithJWTAuthorizer } from "aws-lambda";
import { getDocClient, userKey } from "../lib/db";
import { forbidden, json, notFound, unauthorized } from "../lib/http";
import { requireOriginVerify } from "../lib/origin";
import { type Item, mapUserPartition } from "../lib/shape";

export const handler: APIGatewayProxyHandlerV2WithJWTAuthorizer = async (event) => {
  // Origin lockdown: only CloudFront (which injects x-origin-verify) may call.
  if (!requireOriginVerify(event)) return forbidden();

  // Fail closed: no usable sub claim → 401, never a guess (conventions §Auth).
  const sub = event.requestContext?.authorizer?.jwt?.claims?.["sub"];
  if (typeof sub !== "string" || sub.length === 0) return unauthorized();

  const db = getDocClient();
  const table = process.env.TABLE_NAME ?? "";

  // Full-partition query (META + FOLLOW# + VOTE# + NOTIF# + the rest),
  // paginated defensively — a heavy follower's partition may exceed one page.
  const rows: Item[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await db.send(
      new QueryCommand({
        TableName: table,
        KeyConditionExpression: "PK = :pk",
        ExpressionAttributeValues: { ":pk": userKey(sub).PK },
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
