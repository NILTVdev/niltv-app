/**
 * Notification rules (pure, no I/O): which topic a piece of activity
 * belongs to, the cadence the member picked for it, quiet hours, and when
 * the next summary email may go out. The notifier and the summary sweeper
 * do the reads and writes; every decision about timing lives here.
 *
 * The summary email follows four rules:
 *   - it covers only activity the member has not seen: opening the portal
 *     after something arrived cancels the summary for it
 *   - "now" activity makes it due an hour later; "daily" activity, at 8 AM
 *   - nothing goes out 10 PM to 8 AM in the member's zone
 *   - while they stay away it slows down: daily, then weekly after three
 *     summaries in a row with no visit, then nothing until they come back
 */
import type { ConvKind, NotifyCadence, NotifyTopic, PortalMember } from "@niltv/types";

/** The team's zone: desk alerts, and members who never set one. */
export const TEAM_ZONE = "America/New_York";

export const QUIET_START_HOUR = 22;
export const QUIET_END_HOUR = 8;
/** Staff get the list of desk threads waiting more than a day at this hour (team zone). */
export const DESK_MORNING_HOUR = 9;

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

/** "now" activity still unseen this long after it arrived goes in a summary. */
export const FIRST_SUMMARY_DELAY_MS = HOUR_MS;
/** Two summaries are never closer than this, even for someone who keeps coming back. */
export const MIN_SUMMARY_GAP_MS = 3 * HOUR_MS;
/** Summaries in a row with no visit before they slow to weekly. */
export const WEEKLY_AFTER_IGNORED = 3;
/** ...and before they stop: three daily, then about a month of weekly. */
export const STOP_AFTER_IGNORED = 7;
/** Seen this recently = in the portal now, so the badge is enough. */
export const RECENTLY_SEEN_MS = 3 * MINUTE_MS;
/** Pushes a day for everything but direct messages. */
export const DAILY_PUSH_CAP = 6;
/** A cancellation or new time this close to the event emails right away. */
export const LAST_MINUTE_MS = 2 * DAY_MS;
/** Desk alert emails go out at most this often per desk. */
export const DESK_ALERT_GAP_MS = HOUR_MS;
/** Notes kept on a pending summary (decisions, cancellations). */
export const SUMMARY_NOTES_CAP = 10;

export function cadenceFor(member: PortalMember, topic: NotifyTopic): NotifyCadence {
  if (member.status !== "active") return "off";
  const cadence = member.notify[topic];
  // Channels never push; a stored "now" reads as the summary.
  return topic === "channels" && cadence === "now" ? "daily" : cadence;
}

/** The topic of a new message for one recipient. */
export function messageTopic(
  conv: { kind: ConvKind; scope?: { type: string } | undefined },
  mentioned: boolean,
): NotifyTopic {
  if (conv.kind === "desk" || mentioned) return "direct";
  if (conv.kind === "group") return "groups";
  return conv.scope?.type === "announcements" ? "announcements" : "channels";
}

/* ── Time zones ────────────────────────────────────────────────────────────── */

const formatters = new Map<string, Intl.DateTimeFormat>();

export function validZone(zone: string | undefined): string {
  if (!zone) return TEAM_ZONE;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return zone;
  } catch {
    return TEAM_ZONE;
  }
}

function localParts(date: Date, zone: string): { day: string; hour: number; minute: number } {
  let f = formatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
    formatters.set(zone, f);
  }
  const p = Object.fromEntries(f.formatToParts(date).map((part) => [part.type, part.value]));
  return { day: `${p["year"]}-${p["month"]}-${p["day"]}`, hour: Number(p["hour"]), minute: Number(p["minute"]) };
}

export const localHour = (date: Date, zone: string): number => localParts(date, zone).hour;

/** "2026-10-21" in that zone: the key for once-a-day work. */
export const localDay = (date: Date, zone: string): string => localParts(date, zone).day;

export function isQuietHour(date: Date, zone: string): boolean {
  const hour = localHour(date, zone);
  return hour >= QUIET_START_HOUR || hour < QUIET_END_HOUR;
}

/**
 * The first instant strictly after `date` when the clock in `zone` reads
 * {hour}:00. Every zone offset is a multiple of 15 minutes, so stepping
 * through UTC quarter hours lands on local quarter hours.
 */
export function nextLocalHour(date: Date, zone: string, hour: number): Date {
  const quarter = 15 * MINUTE_MS;
  let t = Math.floor(date.getTime() / quarter) * quarter + quarter;
  for (let i = 0; i < 4 * 24 * 2; i++, t += quarter) {
    const p = localParts(new Date(t), zone);
    if (p.hour === hour && p.minute === 0) return new Date(t);
  }
  return new Date(date.getTime() + DAY_MS);
}

/** The same instant, or 8 AM local when it falls in quiet hours. */
export function outOfQuietHours(date: Date, zone: string): Date {
  return isQuietHour(date, zone) ? nextLocalHour(date, zone, QUIET_END_HOUR) : date;
}

/* ── The summary email ─────────────────────────────────────────────────────── */

/** Something a summary should mention that the portal cannot recompute later. */
export interface SummaryNote {
  topic: NotifyTopic;
  text: string;
  path: string;
  at: string;
}

export interface SummaryState {
  /** the first activity since the member was last seen; unset = nothing pending */
  pendingSince?: string;
  dueAt?: string;
  notes: SummaryNote[];
  lastSummaryAt?: string;
  /** summaries in a row that were not followed by a visit, as of the last one sent */
  ignored: number;
  /** bumped on every write to the pending fields, for conditional writes */
  rev: number;
}

export function summaryDueFor(cadence: "now" | "daily", at: Date, zone: string): Date {
  return cadence === "now"
    ? outOfQuietHours(new Date(at.getTime() + FIRST_SUMMARY_DELAY_MS), zone)
    : nextLocalHour(at, zone, QUIET_END_HOUR);
}

/**
 * Fold one new piece of activity into the pending summary. A pending
 * summary the member has since seen (they opened the portal after it
 * started) is replaced, not extended.
 */
export function addActivity(
  state: SummaryState,
  input: { at: Date; cadence: "now" | "daily"; zone: string; lastSeenAt?: string | undefined; note?: SummaryNote },
): Pick<SummaryState, "pendingSince" | "dueAt" | "notes"> {
  const seen = input.lastSeenAt ? Date.parse(input.lastSeenAt) : 0;
  const live = state.pendingSince !== undefined && seen < Date.parse(state.pendingSince);
  const candidate = summaryDueFor(input.cadence, input.at, input.zone).toISOString();
  const dueAt = live && state.dueAt && state.dueAt <= candidate ? state.dueAt : candidate;
  const notes = [...(live ? state.notes : []), ...(input.note ? [input.note] : [])].slice(-SUMMARY_NOTES_CAP);
  return { pendingSince: live ? state.pendingSince : input.at.toISOString(), dueAt, notes };
}

export type SummaryPlan =
  | { action: "send"; ignored: number; weekly: boolean; last: boolean }
  | { action: "wait"; until: Date }
  | { action: "drop"; reason: "nothing pending" | "seen" | "stopped" };

/** What the sweeper does with a pending summary that has come due. */
export function planSummary(input: {
  now: Date;
  zone: string;
  lastSeenAt?: string | undefined;
  state: SummaryState;
}): SummaryPlan {
  const { now, zone, state } = input;
  if (!state.pendingSince) return { action: "drop", reason: "nothing pending" };
  const seen = input.lastSeenAt ? Date.parse(input.lastSeenAt) : 0;
  if (seen >= Date.parse(state.pendingSince)) return { action: "drop", reason: "seen" };

  const last = state.lastSummaryAt ? Date.parse(state.lastSummaryAt) : undefined;
  const ignoredLast = last !== undefined && seen < last;
  const ignored = ignoredLast ? state.ignored + 1 : 0;
  if (ignored >= STOP_AFTER_IGNORED) return { action: "drop", reason: "stopped" };

  const weekly = ignored >= WEEKLY_AFTER_IGNORED;
  const gap = last === undefined ? 0 : weekly ? 7 * DAY_MS : ignoredLast ? DAY_MS : MIN_SUMMARY_GAP_MS;
  const earliest = last === undefined ? now : new Date(last + gap);
  if (earliest > now) return { action: "wait", until: outOfQuietHours(earliest, zone) };
  if (isQuietHour(now, zone)) return { action: "wait", until: nextLocalHour(now, zone, QUIET_END_HOUR) };
  return { action: "send", ignored, weekly, last: ignored + 1 >= STOP_AFTER_IGNORED };
}

/* ── Push ──────────────────────────────────────────────────────────────────── */

/** Should this activity buzz the member's devices now? (The daily cap is checked separately.) */
export function shouldPush(input: {
  cadence: NotifyCadence;
  topic: NotifyTopic;
  now: Date;
  zone: string;
  lastSeenAt?: string | undefined;
}): boolean {
  if (input.cadence !== "now") return false;
  if (input.lastSeenAt && input.now.getTime() - Date.parse(input.lastSeenAt) < RECENTLY_SEEN_MS) return false;
  // Messages to you may buzz at night; everything else waits for the badge.
  return input.topic === "direct" || !isQuietHour(input.now, input.zone);
}
