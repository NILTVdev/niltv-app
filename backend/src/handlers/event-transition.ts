/**
 * event-transition (design §6.5) — fired by the EventBridge Scheduler
 * one-shots the admin event save creates (and callable directly by the admin
 * status override). Statuses are stored, never inferred:
 *
 *   → live:  set status (+ GSI1SK so the Events-tab partition re-sorts).
 *   → ended: snapshot the leaderboard onto the event item (frozen — the recap
 *            never recomputes), then set status.
 *
 * Both directions finish with a CloudFront invalidation of the read paths so
 * the edge-cached config/home/events views flip promptly. Forward-only and
 * idempotent: a retried invoke (or a manual flip that already happened) is a
 * no-op — the break-glass override in the admin API is the only caller that
 * may force a backwards move.
 */
import {
  CloudFrontClient,
  CreateInvalidationCommand,
} from "@aws-sdk/client-cloudfront";
import { GetCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { EventStatus } from "@niltv/types";
import { ENTRY_SK_PREFIX, eventGsi, eventKey, getDocClient } from "../lib/db";
import { broadcastPush, listVoterUserIds, pushToUsers } from "../lib/push";
import { computeRecap } from "../lib/recap";
import type { Item } from "../lib/shape";

const STATUS_ORDER: Record<string, number> = { upcoming: 0, live: 1, ended: 2 };

export interface TransitionInput {
  eventId: string;
  /** absent when `notify` is set — the closing-soon one-shot changes nothing */
  to?: EventStatus;
  /** notification-only invoke (design §7: the ends_at − 24h one-shot) */
  notify?: "closingSoon";
}

export type TransitionResult = "ok" | "noop" | "not-found";

/**
 * Apply a status transition. `force` (admin override only) permits backwards
 * moves; scheduled invokes are forward-only so a late/retried one-shot can
 * never regress a manually-advanced event.
 */
export async function transitionEvent(
  eventId: string,
  to: EventStatus,
  force = false,
): Promise<TransitionResult> {
  const db = getDocClient();
  const table = process.env.TABLE_NAME ?? "";

  const { Item: eventRow } = await db.send(
    new GetCommand({ TableName: table, Key: eventKey(eventId) }),
  );
  if (!eventRow) return "not-found";

  const from = String(eventRow["status"]);
  if (from === to) return "noop";
  if (!force && (STATUS_ORDER[to] ?? 0) < (STATUS_ORDER[from] ?? 0)) return "noop";

  // → ended: freeze the leaderboard BEFORE flipping status, from the live
  // counters (the vote window is checked against endsAt, so late writes are
  // already impossible by the time the one-shot fires).
  let recap: unknown;
  if (to === "ended") {
    const { Items } = await db.send(
      new QueryCommand({
        TableName: table,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :entry)",
        ExpressionAttributeValues: { ":pk": eventKey(eventId).PK, ":entry": ENTRY_SK_PREFIX },
      }),
    );
    recap = computeRecap(eventRow as Item, (Items ?? []) as Item[]);
  }

  const gsi = eventGsi(to, String(eventRow["startsAt"]));
  await db.send(
    new UpdateCommand({
      TableName: table,
      Key: eventKey(eventId),
      // Guard against a concurrent transition: only move if status is still
      // what we read (the loser of a race becomes a clean no-op on retry).
      ConditionExpression: "#status = :from",
      UpdateExpression:
        recap !== undefined
          ? "SET #status = :to, GSI1SK = :gsi1sk, recap = :recap"
          : "SET #status = :to, GSI1SK = :gsi1sk",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":from": from,
        ":to": to,
        ":gsi1sk": gsi.GSI1SK,
        ...(recap !== undefined ? { ":recap": recap } : {}),
      },
    }),
  );

  await invalidateEdgePaths();
  await sendTransitionPushes(eventId, to, String(eventRow["title"] ?? "NIL STAR"));
  return "ok";
}

/**
 * Lifecycle pushes (design §7): → live broadcasts "voting open" to every
 * opted-in device (which covers upcoming-event "Notify me" opt-ins); → ended
 * sends results to the users who actually voted. Best-effort by design — a
 * push outage must never fail (or re-run) a status transition.
 */
async function sendTransitionPushes(eventId: string, to: EventStatus, title: string): Promise<void> {
  try {
    if (to === "live") {
      const result = await broadcastPush({
        title: "Voting is open! 🌟",
        body: `${title} is live — cast your vote now.`,
        data: { url: `/event/${eventId}` },
      });
      console.log(JSON.stringify({ push: "voting-open", eventId, ...result }));
    } else if (to === "ended") {
      const voters = new Set(await listVoterUserIds(eventId));
      const result = await pushToUsers(voters, {
        title: "The results are in",
        body: `${title} has ended — see who won.`,
        data: { url: `/event/${eventId}` },
      });
      console.log(JSON.stringify({ push: "results", eventId, voters: voters.size, ...result }));
    }
  } catch (err) {
    console.error("transition push failed (transition already committed)", err);
  }
}

/**
 * The closing-soon one-shot (design §7): notification only, no status change.
 * Guarded against stale fires — the event must still be live with the end
 * actually ahead (a rescheduled/ended event turns this into a no-op).
 */
export async function notifyClosingSoon(eventId: string, now: Date = new Date()): Promise<TransitionResult> {
  const db = getDocClient();
  const table = process.env.TABLE_NAME ?? "";
  const { Item: eventRow } = await db.send(
    new GetCommand({ TableName: table, Key: eventKey(eventId) }),
  );
  if (!eventRow) return "not-found";
  if (eventRow["status"] !== "live" || Date.parse(String(eventRow["endsAt"])) <= now.getTime()) {
    return "noop";
  }
  try {
    const result = await broadcastPush({
      title: "Last chance to vote ⏳",
      body: `${String(eventRow["title"] ?? "NIL STAR")} closes in 24 hours.`,
      data: { url: `/event/${eventId}` },
    });
    console.log(JSON.stringify({ push: "closing-soon", eventId, ...result }));
  } catch (err) {
    console.error("closing-soon push failed", err);
  }
  return "ok";
}

/**
 * Flush the edge-cached read paths (design §6.5). Best-effort: only
 * /v1/config is edge-cached today (60s TTL) so a failed invalidation
 * self-heals within a minute — log loudly, never fail the transition over it.
 */
async function invalidateEdgePaths(): Promise<void> {
  const distributionId = process.env.DISTRIBUTION_ID;
  if (!distributionId) return;
  try {
    await new CloudFrontClient({}).send(
      new CreateInvalidationCommand({
        DistributionId: distributionId,
        InvalidationBatch: {
          CallerReference: `event-transition-${Date.now()}`,
          Paths: { Quantity: 3, Items: ["/v1/config", "/v1/home", "/v1/events*"] },
        },
      }),
    );
  } catch (err) {
    console.error("CloudFront invalidation failed (edge cache will self-heal)", err);
  }
}

/** Scheduler entrypoint — the one-shot's payload is the TransitionInput JSON. */
export const handler = async (input: TransitionInput): Promise<TransitionResult> => {
  if (input.notify === "closingSoon") {
    const result = await notifyClosingSoon(input.eventId);
    console.log(JSON.stringify({ eventId: input.eventId, notify: input.notify, result }));
    return result;
  }
  const to = EventStatus.parse(input.to);
  const result = await transitionEvent(input.eventId, to);
  console.log(JSON.stringify({ eventId: input.eventId, to, result }));
  return result;
};
