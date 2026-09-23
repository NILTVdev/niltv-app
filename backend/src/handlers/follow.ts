/**
 * PUT/DELETE /v1/me/follows/{athleteId} (JWT) — follow fact row plus the
 * profile's follower counter in one transaction (design §5 counters: facts
 * are the source of truth, counters are display). Both directions are
 * idempotent: a repeated PUT/DELETE trips the condition check and still
 * returns ok — without moving the counter twice.
 */
import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { ApiError, FollowAckResponse } from "@niltv/types";
import type { APIGatewayProxyHandlerV2WithJWTAuthorizer } from "aws-lambda";
import { followGsi, followKey, getDocClient, isConditionalCheckFailed, profileKey } from "../lib/db";
import { forbidden, json, notFound, unauthorized } from "../lib/http";
import { requireOriginVerify } from "../lib/origin";

export const handler: APIGatewayProxyHandlerV2WithJWTAuthorizer = async (event) => {
  // Origin lockdown: only CloudFront (which injects x-origin-verify) may call.
  if (!requireOriginVerify(event)) return forbidden();

  // Fail closed: no usable sub claim → 401, never a guess (conventions §Auth).
  const sub = event.requestContext?.authorizer?.jwt?.claims?.["sub"];
  if (typeof sub !== "string" || sub.length === 0) return unauthorized();

  const athleteId = event.pathParameters?.["athleteId"];
  if (!athleteId) return notFound();

  const method = event.requestContext.http.method.toUpperCase();
  if (method !== "PUT" && method !== "DELETE") {
    return json(405, ApiError.parse({ error: "METHOD_NOT_ALLOWED" }));
  }
  const isPut = method === "PUT";

  const db = getDocClient();
  const table = process.env.TABLE_NAME ?? "";

  // The athlete must exist — otherwise a typo'd id would mint a counter item.
  const { Item: profile } = await db.send(
    new GetCommand({ TableName: table, Key: profileKey(athleteId) }),
  );
  if (!profile) return notFound();

  try {
    await db.send(
      new TransactWriteCommand({
        TransactItems: [
          isPut
            ? {
                Put: {
                  TableName: table,
                  Item: {
                    ...followKey(sub, athleteId),
                    ...followGsi(sub, athleteId),
                    createdAt: new Date().toISOString(),
                  },
                  ConditionExpression: "attribute_not_exists(PK)",
                },
              }
            : {
                Delete: {
                  TableName: table,
                  Key: followKey(sub, athleteId),
                  ConditionExpression: "attribute_exists(PK)",
                },
              },
          {
            Update: {
              TableName: table,
              Key: profileKey(athleteId),
              UpdateExpression: "ADD followers :delta",
              ExpressionAttributeValues: { ":delta": isPut ? 1 : -1 },
            },
          },
        ],
      }),
    );
  } catch (err) {
    // Already followed / already unfollowed — idempotent ok, counter untouched.
    if (!isConditionalCheckFailed(err)) throw err;
  }

  return json(200, FollowAckResponse.parse({ status: "ok" }));
};
