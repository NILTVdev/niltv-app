/**
 * Per-member write limits for the portal API. One counter row per member and
 * kind of write (USER#{sub} / LIMIT#{bucket}) holds a fixed window and a
 * count, moved with conditional updates like claimPushSlot (activity.ts).
 * The row is overwritten each window, so each member has at most one row per
 * kind and no expiry is needed. The rows sit in the USER# partition, so
 * account deletion clears them.
 *
 * The HTTP API throttle (portal-stack.ts) is shared by every caller. These
 * limits stop one account from flooding staff mailboxes, channels and phones,
 * or spending the SES quota that sign-up codes share.
 */
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { getDocClient } from "../db";

const table = (): string => process.env.TABLE_NAME ?? "";

const isCcf = (err: unknown): boolean => (err as { name?: string }).name === "ConditionalCheckFailedException";

export interface WriteLimit {
  /** the counter this route spends; routes may share one */
  bucket: string;
  max: number;
  windowMs: number;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Write routes with a cap, by HTTP API route key. Routes not listed are not limited here. */
export const ROUTE_LIMITS: Readonly<Record<string, WriteLimit>> = {
  "POST /v1/conversations/{id}/messages": { bucket: "messages", max: 30, windowMs: MINUTE },
  "POST /v1/help": { bucket: "help", max: 5, windowMs: HOUR },
  "POST /v1/requests": { bucket: "requests", max: 5, windowMs: DAY },
  // Interest, withdraw, and staff approve or decline.
  "POST /v1/postings/{id}/action": { bucket: "postings", max: 20, windowMs: MINUTE },
  // Claim, release, submit, and staff decide or review.
  "POST /v1/asks/{id}/action": { bucket: "asks", max: 30, windowMs: MINUTE },
  "POST /v1/asks/{id}/uploads": { bucket: "uploads", max: 30, windowMs: MINUTE },
};

export const RATE_LIMITED_MESSAGE = "Too many in a row. Wait a minute and try again.";

export const limitKey = (sub: string, bucket: string): { PK: string; SK: string } => ({
  PK: `USER#${sub}`,
  SK: `LIMIT#${bucket}`,
});

/** Spend one write from the member's allowance. False once this window's allowance is used up. */
export async function takeWrite(sub: string, limit: WriteLimit, now: number = Date.now()): Promise<boolean> {
  const db = getDocClient();
  const win = Math.floor(now / limit.windowMs);
  const Key = limitKey(sub, limit.bucket);
  try {
    await db.send(
      new UpdateCommand({
        TableName: table(),
        Key,
        UpdateExpression: "ADD n :one",
        ConditionExpression: "win = :win AND n < :max",
        ExpressionAttributeValues: { ":one": 1, ":win": win, ":max": limit.max },
      }),
    );
    return true;
  } catch (err) {
    if (!isCcf(err)) throw err;
  }
  try {
    // First write of a new window (or ever).
    await db.send(
      new UpdateCommand({
        TableName: table(),
        Key,
        UpdateExpression: "SET win = :win, n = :one",
        ConditionExpression: "attribute_not_exists(win) OR win <> :win",
        ExpressionAttributeValues: { ":one": 1, ":win": win },
      }),
    );
    return true;
  } catch (err) {
    if (isCcf(err)) return false;
    throw err;
  }
}
