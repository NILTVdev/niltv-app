/**
 * POST/DELETE /v1/me/likes/{contentId} (JWT) — like fact row plus the clip's
 * likes counter in one transaction, modeled exactly on follow.ts (design §5
 * counters: facts are the source of truth, counters are display). Both
 * directions are idempotent: a repeated POST/DELETE trips the condition check
 * and still returns ok — without moving the counter twice.
 *
 * The ack carries the clip's current likes count: the public detail
 * read (GET /v1/content/{id}) is edge-cached for 60 s, so the client uses the
 * returned count instead of refetching a stale copy.
 */
import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { ApiError, LikeAckResponse } from "@niltv/types";
import type { APIGatewayProxyHandlerV2WithJWTAuthorizer } from "aws-lambda";
import { contentKey, getDocClient, isConditionalCheckFailed, likeKey } from "../lib/db";
import { forbidden, json, notFound, unauthorized } from "../lib/http";
import { requireOriginVerify } from "../lib/origin";

export const handler: APIGatewayProxyHandlerV2WithJWTAuthorizer = async (event) => {
  // Origin lockdown: only CloudFront (which injects x-origin-verify) may call.
  if (!requireOriginVerify(event)) return forbidden();

  // Fail closed: no usable sub claim → 401, never a guess (conventions §Auth).
  const sub = event.requestContext?.authorizer?.jwt?.claims?.["sub"];
  if (typeof sub !== "string" || sub.length === 0) return unauthorized();

  const contentId = event.pathParameters?.["contentId"];
  if (!contentId) return notFound();

  const method = event.requestContext.http.method.toUpperCase();
  if (method !== "POST" && method !== "DELETE") {
    return json(405, ApiError.parse({ error: "METHOD_NOT_ALLOWED" }));
  }
  const isPost = method === "POST";

  const db = getDocClient();
  const table = process.env.TABLE_NAME ?? "";

  // The clip must exist — otherwise a typo'd id would mint a counter item.
  // A tombstone (removed clip, db.ts contentTombstone) is a row too, so it
  // 404s as well; the counter Update below refuses it a second time.
  const { Item: content } = await db.send(
    new GetCommand({ TableName: table, Key: contentKey(contentId) }),
  );
  if (!content || content["removed"] === true) return notFound();

  try {
    await db.send(
      new TransactWriteCommand({
        TransactItems: [
          isPost
            ? {
                Put: {
                  TableName: table,
                  Item: {
                    ...likeKey(sub, contentId),
                    createdAt: new Date().toISOString(),
                  },
                  ConditionExpression: "attribute_not_exists(PK)",
                },
              }
            : {
                Delete: {
                  TableName: table,
                  Key: likeKey(sub, contentId),
                  ConditionExpression: "attribute_exists(PK)",
                },
              },
          {
            Update: {
              TableName: table,
              Key: contentKey(contentId),
              UpdateExpression: "ADD likes :delta",
              // A tombstone never accumulates likes. If one lands
              // between the read above and this write, the condition trips
              // and the idempotent path returns ok with nothing written.
              ConditionExpression: "attribute_not_exists(#removed)",
              ExpressionAttributeNames: { "#removed": "removed" },
              ExpressionAttributeValues: { ":delta": isPost ? 1 : -1 },
            },
          },
        ],
      }),
    );
  } catch (err) {
    // Already liked / already unliked — idempotent ok, counter untouched.
    if (!isConditionalCheckFailed(err)) throw err;
  }

  // Read the counter back so the ack carries the real count on both the
  // success and the idempotent path. Strongly consistent: an eventually
  // consistent read right after the transaction could still see the old
  // value. The write is committed by now, so the read-back never
  // fails the call: on an error the ack goes out without a count and the
  // client keeps its optimistic one. A counter below zero (a META row put
  // again without its likes attribute while fact rows survived) reads as 0
  // instead of failing the ack's nonnegative check.
  let likes: number | undefined;
  try {
    const { Item: row } = await db.send(
      new GetCommand({
        TableName: table,
        Key: contentKey(contentId),
        ProjectionExpression: "likes",
        ConsistentRead: true,
      }),
    );
    const n = Number(row?.["likes"] ?? 0);
    likes = Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0;
  } catch (err) {
    console.error("like: counter read-back failed (the like itself is written)", err);
  }

  return json(200, LikeAckResponse.parse(likes === undefined ? { status: "ok" } : { status: "ok", likes }));
};
