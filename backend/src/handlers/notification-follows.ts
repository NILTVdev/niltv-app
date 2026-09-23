/**
 * PUT /v1/me/notification-follows (JWT) — batch REPLACE of the ★-picker
 * opt-ins (design §4.1: the picker's "Done" sends the full desired state).
 * Existing NOTIF# rows not in the payload are deleted, new ones are written
 * with their TARGET#{type}#{id} GSI mirror — the partition fanout queries
 * (§6.4). Replace semantics make the endpoint naturally idempotent.
 */
import { BatchWriteCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { AckResponse, NotificationFollowsPutRequest } from "@niltv/types";
import type { APIGatewayProxyHandlerV2WithJWTAuthorizer } from "aws-lambda";
import { NOTIF_SK_PREFIX, getDocClient, notifFollowGsi, notifFollowKey, userKey } from "../lib/db";
import { badRequest, forbidden, json, parseJsonBody, unauthorized } from "../lib/http";
import { requireOriginVerify } from "../lib/origin";

const BATCH_WRITE_SIZE = 25;

export const handler: APIGatewayProxyHandlerV2WithJWTAuthorizer = async (event) => {
  // Origin lockdown: only CloudFront (which injects x-origin-verify) may call.
  if (!requireOriginVerify(event)) return forbidden();

  // Fail closed: no usable sub claim → 401, never a guess (conventions §Auth).
  const sub = event.requestContext?.authorizer?.jwt?.claims?.["sub"];
  if (typeof sub !== "string" || sub.length === 0) return unauthorized();

  const request = NotificationFollowsPutRequest.safeParse(
    parseJsonBody(event.body, event.isBase64Encoded === true),
  );
  if (!request.success) return badRequest();

  const db = getDocClient();
  const table = process.env.TABLE_NAME ?? "";
  const now = new Date().toISOString();

  // Desired state, keyed by SK (dedup: the last duplicate in the payload wins).
  const desired = new Map<string, { targetType: string; targetId: string }>();
  for (const follow of request.data.follows) {
    desired.set(notifFollowKey(sub, follow.targetType, follow.targetId).SK, follow);
  }

  // Current NOTIF# rows (paginated defensively).
  const currentSks = new Set<string>();
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await db.send(
      new QueryCommand({
        TableName: table,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :notif)",
        ExpressionAttributeValues: { ":pk": userKey(sub).PK, ":notif": NOTIF_SK_PREFIX },
        ProjectionExpression: "SK",
        ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      }),
    );
    for (const row of page.Items ?? []) currentSks.add(String(row["SK"]));
    exclusiveStartKey = page.LastEvaluatedKey;
  } while (exclusiveStartKey);

  const writes: Array<Record<string, unknown>> = [];
  for (const sk of currentSks) {
    if (!desired.has(sk)) {
      writes.push({ DeleteRequest: { Key: { PK: userKey(sub).PK, SK: sk } } });
    }
  }
  for (const [sk, follow] of desired) {
    if (currentSks.has(sk)) continue; // already opted in — leave createdAt alone
    writes.push({
      PutRequest: {
        Item: {
          ...notifFollowKey(sub, follow.targetType, follow.targetId),
          ...notifFollowGsi(sub, follow.targetType, follow.targetId),
          createdAt: now,
        },
      },
    });
  }

  for (let i = 0; i < writes.length; i += BATCH_WRITE_SIZE) {
    await db.send(
      new BatchWriteCommand({
        RequestItems: { [table]: writes.slice(i, i + BATCH_WRITE_SIZE) },
      }),
    );
  }

  return json(200, AckResponse.parse({ status: "ok" }));
};
