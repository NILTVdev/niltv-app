/**
 * Comment helpers shared by the comments, blocks and admin-moderation
 * handlers: display names, the post rate limiter, cursors and item shaping.
 * Handlers stay thin (conventions); anything testable without AWS lives here.
 */
import { createHash } from "node:crypto";
import { GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { AdminComment, Comment } from "@niltv/types";
import { commentRateKey, getDocClient, isConditionalFailure } from "./db";
import type { Item } from "./shape";

/** Posts (and edits) allowed per user per window. */
export const RATE_MAX = 5;
export const RATE_WINDOW_MS = 60_000;
/** The same text from the same user inside this window is refused as a duplicate. */
export const DUPLICATE_WINDOW_MS = 10 * 60_000;

/**
 * Public display name: first name plus last initial ("Scott L."). Comments
 * are visible to minors and by minors, so full names are never published.
 */
export function displayName(name: unknown): string {
  const parts = (typeof name === "string" ? name : "").trim().split(/\s+/).filter(Boolean);
  const first = parts[0];
  if (!first) return "NILTV Fan";
  const last = parts.length > 1 ? parts[parts.length - 1] : undefined;
  const initial = last ? `${last.charAt(0).toUpperCase()}.` : "";
  return [first.slice(0, 24), initial].filter(Boolean).join(" ");
}

/** Hash for duplicate detection: case-, space- and punctuation-insensitive. */
export function bodyHash(body: string): string {
  const canon = body.toLowerCase().replace(/[^a-z0-9]+/g, "");
  return createHash("sha256").update(canon).digest("hex").slice(0, 16);
}

export type RateVerdict = "ok" | "rate_limited" | "duplicate";

/**
 * Fixed-window limiter on one item per user. Both writes are conditional, so
 * concurrent requests can't both slip past the cap:
 *   1. count up inside the live window while under the cap;
 *   2. otherwise start a fresh window, but only if the old one has expired.
 * If neither condition holds the user is over the limit.
 */
export async function takeRateToken(
  table: string,
  sub: string,
  hash: string,
  now: number = Date.now(),
): Promise<RateVerdict> {
  const db = getDocClient();
  const key = commentRateKey(sub);

  const { Item: prior } = await db.send(new GetCommand({ TableName: table, Key: key, ConsistentRead: true }));
  if (
    prior &&
    prior["lastHash"] === hash &&
    typeof prior["lastHashAt"] === "number" &&
    now - prior["lastHashAt"] < DUPLICATE_WINDOW_MS
  ) {
    return "duplicate";
  }

  const cutoff = now - RATE_WINDOW_MS;
  try {
    await db.send(
      new UpdateCommand({
        TableName: table,
        Key: key,
        UpdateExpression: "ADD #n :one",
        ConditionExpression: "attribute_exists(PK) AND windowStart > :cutoff AND #n < :max",
        ExpressionAttributeNames: { "#n": "n" },
        ExpressionAttributeValues: { ":one": 1, ":cutoff": cutoff, ":max": RATE_MAX },
      }),
    );
    return "ok";
  } catch (err) {
    if (!isConditionalFailure(err)) throw err;
  }
  try {
    await db.send(
      new PutCommand({
        TableName: table,
        Item: { ...key, windowStart: now, n: 1, lastHash: prior?.["lastHash"], lastHashAt: prior?.["lastHashAt"] },
        ConditionExpression: "attribute_not_exists(PK) OR windowStart <= :cutoff",
        ExpressionAttributeValues: { ":cutoff": cutoff },
      }),
    );
    return "ok";
  } catch (err) {
    if (!isConditionalFailure(err)) throw err;
    return "rate_limited";
  }
}

/** Remember the body of a successful post for duplicate detection. */
export async function rememberBody(table: string, sub: string, hash: string, now: number = Date.now()): Promise<void> {
  await getDocClient().send(
    new UpdateCommand({
      TableName: table,
      Key: commentRateKey(sub),
      UpdateExpression: "SET lastHash = :h, lastHashAt = :t",
      ExpressionAttributeValues: { ":h": hash, ":t": now },
    }),
  );
}

/* ── Cursors ──────────────────────────────────────────────────────────────── */

type Cursor = Record<string, unknown>;

export const encodeCursor = (key: Cursor | undefined): string | undefined =>
  key ? Buffer.from(JSON.stringify(key)).toString("base64url") : undefined;

/**
 * Decode a client-supplied cursor. A cursor is untrusted input: it must be a
 * flat object whose partition attribute equals the partition being queried,
 * so it can never be used to start a read in another partition.
 */
export function decodeCursor(raw: string | undefined, pkAttr: string, expectedPk: string): Cursor | undefined | "invalid" {
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return "invalid";
    const obj = parsed as Cursor;
    if (obj[pkAttr] !== expectedPk) return "invalid";
    if (!Object.values(obj).every((v) => typeof v === "string")) return "invalid";
    return obj;
  } catch {
    return "invalid";
  }
}

/* ── Shaping ──────────────────────────────────────────────────────────────── */

/** Reader-facing comment; zod strips table keys and moderation fields. */
export const toComment = (row: Item): Comment => Comment.parse(row);

export const toAdminComment = (row: Item): AdminComment =>
  AdminComment.parse({ ...row, reportCount: Number(row["reportCount"] ?? 0), authorIs18plus: row["authorIs18plus"] === true });
