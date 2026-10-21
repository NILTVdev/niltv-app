/**
 * portal-summary (EventBridge, every 15 minutes): sends what the notifier
 * queued for email.
 *
 *   1. Summary emails: every USER#{sub} / NOTIFY row whose summary has come
 *      due (GSI1 NOTIFY#DUE). planSummary (lib/portal/prefs.ts) decides
 *      send, wait or drop; the content is worked out fresh at send time.
 *   2. Desk alerts: for each desk, one email when a thread starts waiting
 *      on staff (at most hourly), and a 9 AM list of threads waiting more
 *      than a day. Team time zone, never in quiet hours.
 *
 * Nothing goes out while Settings has activityEmails off; due summaries are
 * dropped so turning it on later never sends stale ones. Runs one at a
 * time (reserved concurrency 1), so a summary cannot go out twice.
 */
import { GetCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { Desk, type PortalSettings } from "@niltv/types";
import { GSI1, NOTIFY_DUE_GSI1PK, deskAlertKey, getDocClient } from "../../lib/db";
import { parseState, settleSummary } from "../../lib/portal/activity";
import { waitingDeskThreads } from "../../lib/portal/conversations";
import { sendEmail } from "../../lib/portal/emails";
import { deskRecipients, getMember, getSettings } from "../../lib/portal/members";
import {
  DAY_MS,
  DESK_ALERT_GAP_MS,
  DESK_MORNING_HOUR,
  TEAM_ZONE,
  isQuietHour,
  localDay,
  localHour,
  planSummary,
  validZone,
} from "../../lib/portal/prefs";
import { deskAlertEmail, gatherSummary, isEmpty, summaryEmail } from "../../lib/portal/summary";

const table = (): string => process.env.TABLE_NAME ?? "";

/** Summaries handled per run; the rest wait 15 minutes. */
const PER_RUN = 300;

const isCcf = (err: unknown): boolean => (err as { name?: string }).name === "ConditionalCheckFailedException";

export interface SweepResult {
  sent: number;
  waited: number;
  dropped: number;
  deskAlerts: number;
}

async function dueRows(now: Date): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const page = await getDocClient().send(
      new QueryCommand({
        TableName: table(),
        IndexName: GSI1,
        KeyConditionExpression: "GSI1PK = :pk AND GSI1SK <= :now",
        ExpressionAttributeValues: { ":pk": NOTIFY_DUE_GSI1PK, ":now": now.toISOString() },
        ExclusiveStartKey: startKey,
      }),
    );
    out.push(...((page.Items ?? []) as Record<string, unknown>[]));
    startKey = page.LastEvaluatedKey;
  } while (startKey && out.length < PER_RUN);
  return out.slice(0, PER_RUN);
}

async function sweepSummaries(settings: PortalSettings, now: Date, result: SweepResult): Promise<void> {
  for (const row of await dueRows(now)) {
    const sub = String(row["PK"] ?? "").slice("USER#".length);
    // The index copy can lag; plan from the row itself.
    const item = (await getDocClient().send(new GetCommand({ TableName: table(), Key: { PK: row["PK"], SK: row["SK"] }, ConsistentRead: true }))).Item;
    const state = parseState(item);
    try {
      const member = await getMember(sub);
      if (!settings.activityEmails || !member || member.status !== "active") {
        await settleSummary(sub, state.rev, { action: "drop" });
        result.dropped++;
        continue;
      }
      const plan = planSummary({ now, zone: validZone(member.timezone), lastSeenAt: member.lastSeenAt, state });
      if (plan.action === "wait") {
        await settleSummary(sub, state.rev, { action: "wait", until: plan.until });
        result.waited++;
        continue;
      }
      if (plan.action === "drop") {
        await settleSummary(sub, state.rev, { action: "drop" });
        result.dropped++;
        continue;
      }
      const content = await gatherSummary(member, state.notes, now);
      if (isEmpty(content)) {
        await settleSummary(sub, state.rev, { action: "drop" });
        result.dropped++;
        continue;
      }
      await sendEmail(member.email, summaryEmail(member, content, plan));
      await settleSummary(sub, state.rev, { action: "sent", at: now, ignored: plan.ignored });
      result.sent++;
    } catch (err) {
      console.error("portal-summary: one summary failed", sub, err);
    }
  }
}

/** Claim a desk alert slot: false when another run already took it. */
async function claimDesk(desk: Desk, field: "lastAlertAt" | "morningDay", value: string, previous: string | undefined): Promise<boolean> {
  try {
    await getDocClient().send(
      new UpdateCommand({
        TableName: table(),
        Key: deskAlertKey(desk),
        UpdateExpression: `SET ${field} = :value`,
        ConditionExpression: previous === undefined ? `attribute_not_exists(${field})` : `${field} = :previous`,
        ExpressionAttributeValues: { ":value": value, ...(previous === undefined ? {} : { ":previous": previous }) },
      }),
    );
    return true;
  } catch (err) {
    if (isCcf(err)) return false;
    throw err;
  }
}

async function sweepDesks(settings: PortalSettings, now: Date, result: SweepResult): Promise<void> {
  if (!settings.activityEmails || isQuietHour(now, TEAM_ZONE)) return;
  const today = localDay(now, TEAM_ZONE);
  for (const desk of Desk.options) {
    try {
      const to = await deskRecipients(desk, settings);
      if (to.length === 0) continue;
      const waiting = (await waitingDeskThreads(desk)).map((t) => ({
        personName: t.personName ?? "Member",
        waitingSince: t.waitingSince,
      }));
      const row = (await getDocClient().send(new GetCommand({ TableName: table(), Key: deskAlertKey(desk) }))).Item ?? {};
      const lastAlertAt = typeof row["lastAlertAt"] === "string" ? row["lastAlertAt"] : undefined;
      const morningDay = typeof row["morningDay"] === "string" ? row["morningDay"] : undefined;

      if (localHour(now, TEAM_ZONE) >= DESK_MORNING_HOUR && morningDay !== today) {
        const stale = waiting.filter((w) => now.getTime() - Date.parse(w.waitingSince) >= DAY_MS);
        if ((await claimDesk(desk, "morningDay", today, morningDay)) && stale.length > 0) {
          for (const address of to) await sendEmail(address, deskAlertEmail(desk, stale, "morning"));
          result.deskAlerts++;
        }
      }

      const fresh = waiting.some((w) => !lastAlertAt || w.waitingSince > lastAlertAt);
      const spaced = !lastAlertAt || now.getTime() - Date.parse(lastAlertAt) >= DESK_ALERT_GAP_MS;
      if (fresh && spaced && (await claimDesk(desk, "lastAlertAt", now.toISOString(), lastAlertAt))) {
        for (const address of to) await sendEmail(address, deskAlertEmail(desk, waiting, "new"));
        result.deskAlerts++;
      }
    } catch (err) {
      console.error("portal-summary: desk alert failed", desk, err);
    }
  }
}

export async function sweep(now: Date = new Date()): Promise<SweepResult> {
  const settings = await getSettings();
  const result: SweepResult = { sent: 0, waited: 0, dropped: 0, deskAlerts: 0 };
  await sweepSummaries(settings, now, result);
  await sweepDesks(settings, now, result);
  return result;
}

export const handler = async (): Promise<SweepResult> => {
  const result = await sweep();
  console.log(JSON.stringify({ portalSummary: result }));
  return result;
};
