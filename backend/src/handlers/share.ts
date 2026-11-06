/**
 * POST /v1/me/shares/{contentId} (JWT) — records that the signed-in user shared
 * a clip: a share fact row plus the clip's shares counter in one transaction,
 * modeled on like.ts (design §5 counters: facts are the source of truth,
 * counters are display). A share counts once per account per clip: a repeat
 * trips the condition check and still returns ok, without moving the counter.
 * There is no un-share; the native share sheet cannot be taken back.
 *
 * The ack carries the clip's current shares count, because the public detail
 * read is edge-cached for 60 s.
 */
import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { ApiError, ShareAckResponse } from "@niltv/types";
import type { APIGatewayProxyHandlerV2WithJWTAuthorizer } from "aws-lambda";
import { contentKey, getDocClient, isConditionalCheckFailed, shareKey } from "../lib/db";
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

  if (event.requestContext.http.method.toUpperCase() !== "POST") {
    return json(405, ApiError.parse({ error: "METHOD_NOT_ALLOWED" }));
  }

  const db = getDocClient();
  const table = process.env.TABLE_NAME ?? "";

  // The clip must exist (a typo'd id would otherwise mint a counter item), and
  // a tombstone is a row too, so a removed clip 404s here.
  const { Item: content } = await db.send(
    new GetCommand({ TableName: table, Key: contentKey(contentId) }),
  );
  if (!content || content["removed"] === true) return notFound();

  try {
    await db.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: table,
              Item: { ...shareKey(sub, contentId), createdAt: new Date().toISOString() },
              ConditionExpression: "attribute_not_exists(PK)",
            },
          },
          {
            Update: {
              TableName: table,
              Key: contentKey(contentId),
              UpdateExpression: "ADD shares :one",
              // A tombstone never accumulates shares; if one lands between the
              // read above and this write, the whole transaction is a no-op.
              ConditionExpression: "attribute_not_exists(#removed)",
              ExpressionAttributeNames: { "#removed": "removed" },
              ExpressionAttributeValues: { ":one": 1 },
            },
          },
        ],
      }),
    );
  } catch (err) {
    // Already shared by this account — idempotent ok, counter untouched.
    if (!isConditionalCheckFailed(err)) throw err;
  }

  // Strongly consistent read-back so the ack has the real count on both the
  // success and the idempotent path. The write is committed by now, so a read
  // failure never fails the call: the ack just goes out without a count.
  let shares: number | undefined;
  try {
    const { Item: row } = await db.send(
      new GetCommand({
        TableName: table,
        Key: contentKey(contentId),
        ProjectionExpression: "shares",
        ConsistentRead: true,
      }),
    );
    const n = Number(row?.["shares"] ?? 0);
    shares = Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0;
  } catch (err) {
    console.error("share: counter read-back failed (the share itself is written)", err);
  }

  return json(
    200,
    ShareAckResponse.parse(shares === undefined ? { status: "ok" } : { status: "ok", shares }),
  );
};
