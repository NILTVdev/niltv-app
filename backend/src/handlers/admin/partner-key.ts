/**
 * POST /admin/partners/{id}/rotate-key · /revoke-key (staff).
 *
 * The partner row carries `keyHashes`: every PARTNERKEY row that can still
 * authorize, newest first. Rotate: a new key becomes active, the previous
 * active key keeps working for a grace window (7 days) so the partner can
 * switch without downtime, and any OLDER grace key is revoked on the spot —
 * one grace key at a time. Revoke: every hash in `keyHashes` gets
 * `revokedAt`, so a leaked key that was rotated away is cut too. The partner
 * row keeps existing and its feeds keep building — only API calls stop.
 * Both return the plain key at most once.
 */
import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { AdminPartnerKeyResponse } from "@niltv/types";
import type { APIGatewayProxyHandlerV2WithJWTAuthorizer } from "aws-lambda";
import { getDocClient, partnerApiKeyKey, partnerKey } from "../../lib/db";
import { forbidden, json, notFound } from "../../lib/http";
import { generateApiKey, hashApiKey, keyPrefixOf } from "../../lib/partner-keys";
import { requireStaff } from "./authz";

const GRACE_MS = 7 * 24 * 3600 * 1000;

/** Every hash the partner row knows about: the tracked list plus the active one, deduplicated. */
export function liveKeyHashes(partner: Record<string, unknown>): string[] {
  const hashes: string[] = [];
  const active = partner["activeKeyHash"];
  if (typeof active === "string" && active.length > 0) hashes.push(active);
  if (Array.isArray(partner["keyHashes"])) {
    for (const value of partner["keyHashes"] as unknown[]) {
      if (typeof value === "string" && value.length > 0 && !hashes.includes(value)) hashes.push(value);
    }
  }
  return hashes;
}

export const handler: APIGatewayProxyHandlerV2WithJWTAuthorizer = async (event) => {
  if (!requireStaff(event)) return forbidden();

  const partnerId = event.pathParameters?.["id"];
  if (!partnerId) return notFound();
  const path = event.rawPath ?? event.requestContext?.http?.path ?? "";
  const action = path.endsWith("/rotate-key") ? "rotate" : path.endsWith("/revoke-key") ? "revoke" : undefined;
  if (action === undefined) return notFound();

  const db = getDocClient();
  const table = process.env.TABLE_NAME ?? "";
  const { Item: partner } = await db.send(new GetCommand({ TableName: table, Key: partnerKey(partnerId) }));
  if (!partner) return notFound();
  const activeHash = typeof partner["activeKeyHash"] === "string" ? partner["activeKeyHash"] : undefined;
  const hashes = liveKeyHashes(partner);
  const now = new Date();
  const nowIso = now.toISOString();

  const revokeItem = (hash: string) => ({
    Update: {
      TableName: table,
      Key: partnerApiKeyKey(hash),
      UpdateExpression: "SET revokedAt = :now",
      ExpressionAttributeValues: { ":now": nowIso },
    },
  });

  if (action === "revoke") {
    await db.send(
      new TransactWriteCommand({
        TransactItems: [
          ...hashes.map(revokeItem),
          {
            Update: {
              TableName: table,
              Key: partnerKey(partnerId),
              UpdateExpression: "SET keyRotatedAt = :now, updatedAt = :now, keyHashes = :none REMOVE activeKeyHash, keyPrefix",
              ExpressionAttributeValues: { ":now": nowIso, ":none": [] },
            },
          },
        ],
      }),
    );
    return json(200, AdminPartnerKeyResponse.parse({ status: "revoked" }));
  }

  const apiKey = generateApiKey(process.env.STAGE ?? "dev");
  const keyHash = hashApiKey(process.env.PARTNER_KEY_PEPPER ?? "", apiKey);
  const graceUntil = new Date(now.getTime() + GRACE_MS).toISOString();
  // The outgoing active key gets the grace window; anything older is cut now.
  const olderHashes = hashes.filter((hash) => hash !== activeHash);
  await db.send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Put: {
            TableName: table,
            Item: { ...partnerApiKeyKey(keyHash), partnerId, keyPrefix: keyPrefixOf(apiKey), createdAt: nowIso },
            ConditionExpression: "attribute_not_exists(PK)",
          },
        },
        ...(activeHash
          ? [
              {
                Update: {
                  TableName: table,
                  Key: partnerApiKeyKey(activeHash),
                  UpdateExpression: "SET expiresAt = :until",
                  ExpressionAttributeValues: { ":until": graceUntil },
                },
              },
            ]
          : []),
        ...olderHashes.map(revokeItem),
        {
          Update: {
            TableName: table,
            Key: partnerKey(partnerId),
            UpdateExpression:
              "SET activeKeyHash = :hash, keyHashes = :hashes, keyPrefix = :prefix, keyRotatedAt = :now, updatedAt = :now",
            ExpressionAttributeValues: {
              ":hash": keyHash,
              ":hashes": activeHash ? [keyHash, activeHash] : [keyHash],
              ":prefix": keyPrefixOf(apiKey),
              ":now": nowIso,
            },
          },
        },
      ],
    }),
  );
  return json(
    200,
    AdminPartnerKeyResponse.parse({
      status: "rotated",
      apiKey,
      keyPrefix: keyPrefixOf(apiKey),
      ...(activeHash ? { previousKeyExpiresAt: graceUntil } : {}),
    }),
  );
};
