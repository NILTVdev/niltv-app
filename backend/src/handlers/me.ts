/**
 * GET/PATCH /v1/me (JWT) — identity plus everything gated UI needs in one call
 * (design §4.1): votes{}, follows[], notification follows, mapped from the
 * full USER#{sub} partition. Never cached (Cache-Control private, no-store).
 */
import { QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { MeUpdateRequest } from "@niltv/types";
import type { APIGatewayProxyHandlerV2WithJWTAuthorizer } from "aws-lambda";
import { getDocClient, userKey } from "../lib/db";
import { badRequest, forbidden, json, notFound, parseJsonBody, unauthorized } from "../lib/http";
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
  const isPatch = event.requestContext?.http?.method === "PATCH";

  if (isPatch) {
    const request = MeUpdateRequest.safeParse(parseJsonBody(event.body, event.isBase64Encoded === true));
    if (!request.success) return badRequest();

    try {
      await db.send(
        new UpdateCommand({
          TableName: table,
          Key: userKey(sub),
          ConditionExpression: "attribute_exists(PK)",
          UpdateExpression: "SET displayName = :displayName",
          ExpressionAttributeValues: { ":displayName": request.data.displayName },
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
  }

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
        ...(isPatch ? { ConsistentRead: true } : {}),
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
