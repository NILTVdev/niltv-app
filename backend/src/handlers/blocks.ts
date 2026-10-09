/**
 * Blocking (JWT), App Store guideline 1.2:
 *
 *   GET    /v1/me/blocks             the caller's blocked users
 *   PUT    /v1/me/blocks/{userId}    block (idempotent)
 *   DELETE /v1/me/blocks/{userId}    unblock (idempotent)
 *
 * A block is a private one-way fact row, USER#{me} / BLOCK#{them}. The
 * blocked user is never told. The comments list applies it at read time.
 */
import { DeleteCommand, GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { AckResponse, ApiError, BlocksResponse } from "@niltv/types";
import type { APIGatewayProxyHandlerV2WithJWTAuthorizer } from "aws-lambda";
import { displayName } from "../lib/comments";
import { BLOCK_SK_PREFIX, blockKey, getDocClient, userKey } from "../lib/db";
import { badRequest, forbidden, json, notFound, unauthorized } from "../lib/http";
import { requireOriginVerify } from "../lib/origin";

export const handler: APIGatewayProxyHandlerV2WithJWTAuthorizer = async (event) => {
  if (!requireOriginVerify(event)) return forbidden();

  const sub = event.requestContext?.authorizer?.jwt?.claims?.["sub"];
  if (typeof sub !== "string" || sub.length === 0) return unauthorized();

  const table = process.env.TABLE_NAME ?? "";
  const db = getDocClient();
  const method = event.requestContext.http.method.toUpperCase();
  const targetId = event.pathParameters?.["userId"];

  if (!targetId) {
    if (method !== "GET") return json(405, ApiError.parse({ error: "METHOD_NOT_ALLOWED" }));
    const blocks: Array<{ userId: string; name: string }> = [];
    let start: Record<string, unknown> | undefined;
    do {
      const page = await db.send(
        new QueryCommand({
          TableName: table,
          KeyConditionExpression: "PK = :pk AND begins_with(SK, :p)",
          ExpressionAttributeValues: { ":pk": userKey(sub).PK, ":p": BLOCK_SK_PREFIX },
          ...(start ? { ExclusiveStartKey: start } : {}),
        }),
      );
      for (const row of page.Items ?? []) {
        blocks.push({ userId: String(row["SK"]).slice(BLOCK_SK_PREFIX.length), name: displayName(row["name"]) });
      }
      start = page.LastEvaluatedKey;
    } while (start);
    return json(200, BlocksResponse.parse({ blocks }), "private, no-store");
  }

  if (method === "PUT") {
    if (targetId === sub) return badRequest("you can't block yourself");
    // The name is read from the target's row, never taken from the client.
    const { Item: target } = await db.send(new GetCommand({ TableName: table, Key: userKey(targetId) }));
    if (!target) return notFound();
    await db.send(
      new PutCommand({
        TableName: table,
        Item: { ...blockKey(sub, targetId), name: displayName(target["name"]), createdAt: new Date().toISOString() },
      }),
    );
  } else if (method === "DELETE") {
    await db.send(new DeleteCommand({ TableName: table, Key: blockKey(sub, targetId) }));
  } else {
    return json(405, ApiError.parse({ error: "METHOD_NOT_ALLOWED" }));
  }
  return json(200, AckResponse.parse({ status: "ok" }));
};
