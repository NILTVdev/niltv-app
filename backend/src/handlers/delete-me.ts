/**
 * DELETE /v1/me (JWT) — account deletion (App Store 5.1.1(v), design §6.6).
 * Purge order is chosen so a mid-purge crash retries cleanly off the same JWT:
 *
 *   1. Vote rows are ANONYMIZED, never deleted — each is copied under
 *      USER#deleted#{sha256(sub)} with its EVENT GSI mirror rewritten, so
 *      contest tallies and the audit export stay intact per Official Rules.
 *   2. Follow/like rows are deleted WITH their display-counter decrement
 *      (facts and counters move together, design §5).
 *   3. Devices, notif-follows, the newsletter subscription and finally the
 *      META row are deleted.
 *   4. Cognito AdminDeleteUser last — until it succeeds the user can retry.
 */
import { createHash } from "node:crypto";
import {
  AdminDeleteUserCommand,
  CognitoIdentityProviderClient,
  UserNotFoundException,
} from "@aws-sdk/client-cognito-identity-provider";
import { DeleteCommand, PutCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { AckResponse } from "@niltv/types";
import type { APIGatewayProxyHandlerV2WithJWTAuthorizer } from "aws-lambda";
import {
  FOLLOW_SK_PREFIX,
  LIKE_SK_PREFIX,
  VOTE_SK_PREFIX,
  contentKey,
  deletedUserPk,
  getDocClient,
  isConditionalCheckFailed,
  profileKey,
  subscriberKey,
  userKey,
} from "../lib/db";
import { forbidden, json, unauthorized } from "../lib/http";
import { requireOriginVerify } from "../lib/origin";
import type { Item } from "../lib/shape";

let cognitoClient: CognitoIdentityProviderClient | undefined;
const getCognito = (): CognitoIdentityProviderClient =>
  (cognitoClient ??= new CognitoIdentityProviderClient({}));

/** Deterministic anonymous id — a retried purge lands on the same key. */
export const anonymousHash = (sub: string): string =>
  createHash("sha256").update(sub).digest("hex").slice(0, 16);

/** Delete a fact row together with its display-counter decrement; plain-delete when the counted row is gone. */
async function deleteWithCounter(
  table: string,
  rowKey: { PK: string; SK: string },
  counterKey: { PK: string; SK: string },
  counterAttr: string,
): Promise<void> {
  const db = getDocClient();
  try {
    await db.send(
      new TransactWriteCommand({
        TransactItems: [
          { Delete: { TableName: table, Key: rowKey } },
          {
            Update: {
              TableName: table,
              Key: counterKey,
              // Never mint a ghost counter item for a deleted athlete/clip.
              ConditionExpression: "attribute_exists(PK)",
              UpdateExpression: `ADD ${counterAttr} :minus`,
              ExpressionAttributeValues: { ":minus": -1 },
            },
          },
        ],
      }),
    );
  } catch (err) {
    if (!isConditionalCheckFailed(err)) throw err;
    await db.send(new DeleteCommand({ TableName: table, Key: rowKey }));
  }
}

export const handler: APIGatewayProxyHandlerV2WithJWTAuthorizer = async (event) => {
  // Origin lockdown: only CloudFront (which injects x-origin-verify) may call.
  if (!requireOriginVerify(event)) return forbidden();

  // Fail closed: no usable sub claim → 401, never a guess (conventions §Auth).
  const claims = event.requestContext?.authorizer?.jwt?.claims ?? {};
  const sub = claims["sub"];
  if (typeof sub !== "string" || sub.length === 0) return unauthorized();

  const db = getDocClient();
  const table = process.env.TABLE_NAME ?? "";
  const anonPk = deletedUserPk(anonymousHash(sub));

  // Full partition read (paginated defensively — heavy followers).
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

  const meta = rows.find((r) => r["SK"] === "META");

  for (const row of rows) {
    const sk = String(row["SK"]);
    const rowKey = { PK: userKey(sub).PK, SK: sk };

    if (sk.startsWith(VOTE_SK_PREFIX)) {
      // Anonymize: same SK under the deleted# partition, GSI mirror rewritten
      // so the audit export shows deleted#{hash} instead of the account id.
      const entryId = String(row["entryId"] ?? "");
      await db.send(
        new PutCommand({
          TableName: table,
          Item: {
            ...row,
            PK: anonPk,
            GSI1SK: `VOTE#${entryId}#deleted#${anonymousHash(sub)}`,
          },
        }),
      );
      await db.send(new DeleteCommand({ TableName: table, Key: rowKey }));
    } else if (sk.startsWith(FOLLOW_SK_PREFIX)) {
      await deleteWithCounter(table, rowKey, profileKey(sk.slice(FOLLOW_SK_PREFIX.length)), "followers");
    } else if (sk.startsWith(LIKE_SK_PREFIX)) {
      await deleteWithCounter(table, rowKey, contentKey(sk.slice(LIKE_SK_PREFIX.length)), "likes");
    } else if (sk !== "META") {
      // DEVICE#, NOTIF#, anything future — plain delete (GSI mirrors ride along).
      await db.send(new DeleteCommand({ TableName: table, Key: rowKey }));
    }
  }

  // Unsubscribe newsletter (design §6.6), then drop the META row last so a
  // mid-purge retry still finds the partition addressable.
  const email = typeof meta?.["email"] === "string" ? meta["email"].trim().toLowerCase() : undefined;
  if (email) {
    await db.send(new DeleteCommand({ TableName: table, Key: subscriberKey(email) }));
  }
  if (meta) {
    await db.send(new DeleteCommand({ TableName: table, Key: userKey(sub) }));
  }

  // Cognito last — idempotent (an already-deleted user is success, so a
  // retry after a partial failure completes cleanly).
  const username = typeof claims["cognito:username"] === "string" ? claims["cognito:username"] : sub;
  try {
    await getCognito().send(
      new AdminDeleteUserCommand({
        UserPoolId: process.env.USER_POOL_ID ?? "",
        Username: username,
      }),
    );
  } catch (err) {
    if (!(err instanceof UserNotFoundException)) throw err;
  }

  return json(200, AckResponse.parse({ status: "ok" }));
};
