/**
 * USER#{sub} / NOTIFY: what is waiting to reach one member outside the
 * portal. The notifier folds activity into the pending summary
 * (queueSummary); the summary sweeper settles it (settleSummary). Writes to
 * the pending fields are conditional on `rev`, so two notices landing at
 * once both count. Timing rules live in prefs.ts.
 */
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { NotifyTopic, PortalMember } from "@niltv/types";
import { NOTIFY_DUE_GSI1PK, backoffDelayMs, getDocClient, notifyStateKey } from "../db";
import { DAILY_PUSH_CAP, type SummaryNote, type SummaryState, addActivity, validZone } from "./prefs";

const table = (): string => process.env.TABLE_NAME ?? "";

const isCcf = (err: unknown): boolean => (err as { name?: string }).name === "ConditionalCheckFailedException";

const ATTEMPTS = 4;

function parseNote(value: unknown): SummaryNote | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v["text"] !== "string" || typeof v["path"] !== "string") return undefined;
  return {
    topic: (typeof v["topic"] === "string" ? v["topic"] : "direct") as NotifyTopic,
    text: v["text"],
    path: v["path"],
    at: typeof v["at"] === "string" ? v["at"] : new Date(0).toISOString(),
  };
}

export function parseState(item: Record<string, unknown> | undefined): SummaryState {
  const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return {
    ...(str(item?.["pendingSince"]) ? { pendingSince: item!["pendingSince"] as string } : {}),
    ...(str(item?.["dueAt"]) ? { dueAt: item!["dueAt"] as string } : {}),
    notes: Array.isArray(item?.["notes"])
      ? (item!["notes"] as unknown[]).map(parseNote).filter((n): n is SummaryNote => n !== undefined)
      : [],
    ...(str(item?.["lastSummaryAt"]) ? { lastSummaryAt: item!["lastSummaryAt"] as string } : {}),
    ignored: num(item?.["ignored"]),
    rev: num(item?.["rev"]),
  };
}

export async function getState(sub: string): Promise<SummaryState> {
  const out = await getDocClient().send(new GetCommand({ TableName: table(), Key: notifyStateKey(sub), ConsistentRead: true }));
  return parseState(out.Item);
}

/** Condition that the pending fields are still the ones we read. */
const sameRev = (rev: number): { ConditionExpression: string; values: Record<string, unknown> } =>
  rev === 0
    ? { ConditionExpression: "attribute_not_exists(rev) OR rev = :rev", values: { ":rev": 0 } }
    : { ConditionExpression: "rev = :rev", values: { ":rev": rev } };

/** Count a piece of activity toward this member's next summary email. */
export async function queueSummary(
  member: PortalMember,
  input: { at: Date; cadence: "now" | "daily"; note?: SummaryNote },
): Promise<void> {
  const zone = validZone(member.timezone);
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const state = await getState(member.sub);
    const next = addActivity(state, { ...input, zone, lastSeenAt: member.lastSeenAt });
    const cond = sameRev(state.rev);
    try {
      await getDocClient().send(
        new UpdateCommand({
          TableName: table(),
          Key: notifyStateKey(member.sub),
          UpdateExpression:
            "SET pendingSince = :since, dueAt = :due, notes = :notes, GSI1PK = :pk, GSI1SK = :due, rev = :next",
          ConditionExpression: cond.ConditionExpression,
          ExpressionAttributeValues: {
            ...cond.values,
            ":since": next.pendingSince,
            ":due": next.dueAt,
            ":notes": next.notes,
            ":pk": NOTIFY_DUE_GSI1PK,
            ":next": state.rev + 1,
          },
        }),
      );
      return;
    } catch (err) {
      if (!isCcf(err)) throw err;
      await new Promise((resolve) => setTimeout(resolve, backoffDelayMs(attempt)));
    }
  }
  throw new Error(`summary state for ${member.sub} kept changing`);
}

export type Settlement =
  | { action: "sent"; at: Date; ignored: number }
  | { action: "wait"; until: Date }
  | { action: "drop" };

/**
 * Settle a due summary. False when new activity landed since the read: the
 * pending summary stays (a send still records itself, so the gap holds).
 */
export async function settleSummary(sub: string, rev: number, outcome: Settlement): Promise<boolean> {
  const cond = sameRev(rev);
  const db = getDocClient();
  const update = (expr: string, values: Record<string, unknown>, conditional: boolean): UpdateCommand =>
    new UpdateCommand({
      TableName: table(),
      Key: notifyStateKey(sub),
      UpdateExpression: expr,
      ...(conditional ? { ConditionExpression: cond.ConditionExpression } : {}),
      ExpressionAttributeValues: { ...(conditional ? cond.values : {}), ...values },
    });
  const clear = "REMOVE pendingSince, dueAt, notes, GSI1PK, GSI1SK";
  try {
    if (outcome.action === "wait") {
      const until = outcome.until.toISOString();
      await db.send(update("SET dueAt = :until, GSI1SK = :until, rev = :next", { ":until": until, ":next": rev + 1 }, true));
    } else if (outcome.action === "drop") {
      await db.send(update(`SET rev = :next ${clear}`, { ":next": rev + 1 }, true));
    } else {
      const values = { ":at": outcome.at.toISOString(), ":ignored": outcome.ignored };
      try {
        await db.send(update(`SET lastSummaryAt = :at, ignored = :ignored, rev = :next ${clear}`, { ...values, ":next": rev + 1 }, true));
      } catch (err) {
        if (!isCcf(err)) throw err;
        await db.send(update("SET lastSummaryAt = :at, ignored = :ignored", values, false));
        return false;
      }
    }
    return true;
  } catch (err) {
    if (isCcf(err)) return false;
    throw err;
  }
}

/**
 * Take one of today's pushes (non-direct topics). False once the member's
 * cap for the day (in their zone) is used up.
 */
export async function claimPushSlot(sub: string, day: string, cap: number = DAILY_PUSH_CAP): Promise<boolean> {
  const db = getDocClient();
  try {
    await db.send(
      new UpdateCommand({
        TableName: table(),
        Key: notifyStateKey(sub),
        UpdateExpression: "ADD pushCount :one",
        ConditionExpression: "pushDay = :day AND pushCount < :cap",
        ExpressionAttributeValues: { ":one": 1, ":day": day, ":cap": cap },
      }),
    );
    return true;
  } catch (err) {
    if (!isCcf(err)) throw err;
  }
  try {
    // First push of a new day (or ever).
    await db.send(
      new UpdateCommand({
        TableName: table(),
        Key: notifyStateKey(sub),
        UpdateExpression: "SET pushDay = :day, pushCount = :one",
        ConditionExpression: "attribute_not_exists(pushDay) OR pushDay <> :day",
        ExpressionAttributeValues: { ":one": 1, ":day": day },
      }),
    );
    return true;
  } catch (err) {
    if (isCcf(err)) return false;
    throw err;
  }
}
