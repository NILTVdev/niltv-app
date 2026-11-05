/**
 * The summary email: what is waiting for one member, worked out fresh when
 * it goes out (so a poll answered in the meantime never shows up), plus
 * the notes the notifier kept for things the portal cannot recompute
 * (decisions, cancellations, new times). Message lines carry counts, never
 * message text.
 *
 * Also the staff desk alerts, which list desk threads waiting on a reply.
 */
import { BatchGetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import {
  Audience,
  DESK_LABELS,
  type Desk,
  type NotifyTopic,
  type PortalMember,
  isStaffRole,
  portalCan,
} from "@niltv/types";
import { z } from "zod";
import {
  GSI1,
  PORTAL_EVENTS_GSI1PK,
  POSTINGS_ALL_GSI1PK,
  getDocClient,
  portalEventRsvpKey,
  portalEventVoteKey,
} from "../db";
import { audienceIncludes } from "./audience";
import { inbox, listMemberships } from "./conversations";
import { type PortalEmail, formatWhen } from "./emails";
import { type SummaryNote, cadenceFor, messageTopic } from "./prefs";

const table = (): string => process.env.TABLE_NAME ?? "";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
/** Rows in one summary before "and N more". */
const MAX_ROWS = 12;

export interface SummaryContent {
  threads: { title: string; unread: number; mentioned: boolean }[];
  polls: { title: string; path: string }[];
  events: { title: string; startsAt: string; path: string }[];
  postings: { title: string; path: string }[];
  notes: SummaryNote[];
}

export const isEmpty = (c: SummaryContent): boolean =>
  c.threads.length + c.polls.length + c.events.length + c.postings.length + c.notes.length === 0;

/* ── Reads ─────────────────────────────────────────────────────────────────── */

const EventRow = z.object({
  id: z.string(),
  title: z.string(),
  status: z.enum(["poll", "set", "cancelled"]),
  options: z.array(z.object({ id: z.string(), startsAt: z.string(), endsAt: z.string().optional() })),
  lockedOptionId: z.string().optional(),
  audience: Audience,
});
type EventRow = z.infer<typeof EventRow>;

const PostingRow = z.object({ id: z.string(), title: z.string(), status: z.enum(["open", "closed"]), createdAt: z.string() });

async function queryGsi(pk: string, limit: number): Promise<Record<string, unknown>[]> {
  const out = await getDocClient().send(
    new QueryCommand({
      TableName: table(),
      IndexName: GSI1,
      KeyConditionExpression: "GSI1PK = :pk",
      ExpressionAttributeValues: { ":pk": pk },
      ScanIndexForward: false,
      Limit: limit,
    }),
  );
  return (out.Items ?? []) as Record<string, unknown>[];
}

/** Which of these events the member has answered (a vote on a poll, an RSVP on a set event). */
async function answered(events: EventRow[], sub: string): Promise<Set<string>> {
  const out = new Set<string>();
  for (let i = 0; i < events.length; i += 50) {
    const keys = events
      .slice(i, i + 50)
      .flatMap((e) => [{ ...portalEventVoteKey(e.id, sub) }, { ...portalEventRsvpKey(e.id, sub) }]);
    const res = await getDocClient().send(new BatchGetCommand({ RequestItems: { [table()]: { Keys: keys } } }));
    for (const item of res.Responses?.[table()] ?? []) {
      const id = String(item["PK"] ?? "").slice("PEVENT#".length);
      const sk = String(item["SK"] ?? "");
      const event = events.find((e) => e.id === id);
      if (!event) continue;
      if (event.status === "poll" && sk.startsWith("VOTE#") && Array.isArray(item["optionIds"]) && item["optionIds"].length > 0) out.add(id);
      if (event.status === "set" && sk.startsWith("RSVP#")) out.add(id);
    }
  }
  return out;
}

/** Everything waiting for this member right now, by the topics they keep on. */
export async function gatherSummary(member: PortalMember, notes: SummaryNote[], now: Date): Promise<SummaryContent> {
  const on = (topic: NotifyTopic): boolean => cadenceFor(member, topic) !== "off";
  const staff = isStaffRole(member.role);

  // Staff hear about desk threads through the desk alerts, not here.
  const threads = (await inbox(member))
    .filter((t) => t.unread > 0 && !(staff && t.kind === "desk"))
    .filter((t) => !t.muted || t.mentioned)
    .filter((t) => on(messageTopic(t, t.mentioned)))
    .sort((a, b) => Number(b.mentioned) - Number(a.mentioned) || b.unread - a.unread)
    .map((t) => ({ title: t.title, unread: t.unread, mentioned: t.mentioned }));

  const polls: SummaryContent["polls"] = [];
  const events: SummaryContent["events"] = [];
  if (!staff && on("schedule")) {
    const groupIds = new Set(
      (await listMemberships(member.sub)).filter((m) => m.kind === "group" && !m.marker).map((m) => m.convId),
    );
    const open = (await queryGsi(PORTAL_EVENTS_GSI1PK, 300))
      .map((item) => EventRow.safeParse(item))
      .filter((p): p is { success: true; data: EventRow } => p.success)
      .map((p) => p.data)
      .filter((e) => audienceIncludes(e.audience, member, groupIds))
      .filter((e) => {
        if (e.status === "poll") return e.options.some((o) => Date.parse(o.startsAt) > now.getTime());
        const locked = e.options.find((o) => o.id === e.lockedOptionId);
        return e.status === "set" && locked !== undefined && Date.parse(locked.startsAt) > now.getTime();
      });
    const done = await answered(open, member.sub);
    for (const e of open) {
      if (done.has(e.id)) continue;
      const path = `/schedule/${encodeURIComponent(e.id)}`;
      if (e.status === "poll") polls.push({ title: e.title, path });
      else events.push({ title: e.title, startsAt: e.options.find((o) => o.id === e.lockedOptionId)!.startsAt, path });
    }
    events.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  }

  const postings: SummaryContent["postings"] = [];
  if (portalCan(member.role, "athleteTools") && on("postings")) {
    const since = member.lastSeenAt ?? new Date(now.getTime() - WEEK_MS).toISOString();
    for (const item of await queryGsi(POSTINGS_ALL_GSI1PK, 50)) {
      const p = PostingRow.safeParse(item);
      if (p.success && p.data.status === "open" && p.data.createdAt > since) {
        postings.push({ title: p.data.title, path: `/postings/${encodeURIComponent(p.data.id)}` });
      }
    }
  }

  return { threads, polls, events, postings, notes: notes.filter((n) => on(n.topic)) };
}

/* ── Emails ────────────────────────────────────────────────────────────────── */

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

export function summaryEmail(
  member: PortalMember,
  content: SummaryContent,
  plan: { weekly: boolean; last: boolean },
): PortalEmail {
  const messages = content.threads.reduce((sum, t) => sum + t.unread, 0);
  const others = content.polls.length + content.events.length + content.postings.length + content.notes.length;
  const subject =
    messages > 0 && others === 0
      ? `${plural(messages, "unread message", "unread messages")} in the NIL TV Portal`
      : messages === 0
        ? `${plural(others, "thing", "things")} waiting for you in the NIL TV Portal`
        : `${plural(messages, "unread message", "unread messages")} and ${others} more in the NIL TV Portal`;

  const rows: { label: string; detail?: string }[] = [
    ...content.threads.map((t) => ({
      label: t.title,
      detail: t.mentioned
        ? `${t.unread} new, including an @mention of you`
        : plural(t.unread, "new message", "new messages"),
    })),
    ...content.polls.map((p) => ({ label: `Pick your times: ${p.title}`, detail: "These times are waiting on your answer." })),
    ...content.events.map((e) => ({ label: e.title, detail: `${formatWhen(e.startsAt, member.timezone)}. You have not replied yet.` })),
    ...content.postings.map((p) => ({ label: `New posting: ${p.title}` })),
    ...content.notes.map((n) => ({ label: n.text })),
  ];
  const shown = rows.slice(0, MAX_ROWS);
  if (rows.length > shown.length) shown.push({ label: `And ${rows.length - shown.length} more in the portal.` });

  const pace = plan.last
    ? " This is the last summary until you open the portal again."
    : plan.weekly
      ? " You have not opened the portal in a while, so these now come once a week."
      : "";
  return {
    subject,
    heading: "Waiting for you",
    lead: "Here is what is new since you last opened the portal.",
    rows: shown,
    button: { label: "Open the portal", path: content.threads.length ? "/messages" : "/" },
    tail: `You get this when something waits for you in the NIL TV Portal. Choose what reaches you in Account.${pace}`,
  };
}

export interface WaitingThread {
  personName: string;
  waitingSince: string;
}

export function deskAlertEmail(desk: Desk, waiting: readonly WaitingThread[], kind: "new" | "morning"): PortalEmail {
  const label = DESK_LABELS[desk];
  const rows = waiting.slice(0, MAX_ROWS).map((w) => ({
    label: w.personName,
    detail: `Waiting since ${formatWhen(w.waitingSince, undefined)}`,
  }));
  const more = waiting.length - rows.length;
  const list: { label: string; detail?: string }[] = more > 0 ? [...rows, { label: `And ${more} more.` }] : rows;
  const tail = `You get this because you answer the ${label} desk in the NIL TV Portal.`;
  if (kind === "morning") {
    return {
      subject: `${plural(waiting.length, "desk thread has", "desk threads have")} waited more than a day`,
      heading: "Still waiting",
      lead: `These ${label} threads have had no reply for more than a day.`,
      rows: list,
      button: { label: "Open Messages", path: "/messages" },
      tail,
    };
  }
  return {
    subject:
      waiting.length === 1
        ? `${waiting[0]!.personName} is waiting on ${label}`
        : `${waiting.length} people are waiting on ${label}`,
    heading: "Waiting on your desk",
    lead: `${plural(waiting.length, "thread", "threads")} in ${label} ${waiting.length === 1 ? "has" : "have"} no reply yet.`,
    rows: list,
    button: { label: "Open Messages", path: "/messages" },
    tail: `${tail} Alerts come at most once an hour.`,
  };
}
