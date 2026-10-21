/**
 * portal-notify (SQS consumer): turns portal notices (lib/portal/notify.ts)
 * into phone and browser notifications, entries in each member's summary
 * email, and the few emails that go out right away. Timing rules live in
 * lib/portal/prefs.ts; summary emails and desk alerts go out from
 * portal-summary (handlers/portal/summary.ts).
 *
 *   activity                          topic           right away
 *   desk message from athlete/guest   staff direct    push the desk's staff (email = hourly desk alert)
 *   desk reply from staff             direct          push
 *   group message                     groups          push
 *   @mention                          direct          push, even in a muted thread
 *   announcement                      announcements   push; "important" also emails now
 *   other channel post                channels        nothing (summary only)
 *   new posting                       postings        push when they chose right away
 *   approve / decline                 direct          push
 *   new event, time set               schedule        push
 *   cancelled, new time               schedule        push; within 48 hours also emails now
 *
 * Each of these also counts toward the member's summary email unless the
 * topic is off for them. Push and email sit behind admin switches
 * (Settings: webPush, activityEmails), off until testing ends.
 *
 * Always on, whatever those switches say (staff work queues):
 *   interest in an approval posting   the staff member who posted it
 *   page change request               the Athlete support desk
 *   help form                         the support address, reply-to the sender
 *   welcome                           its own switch (Settings: welcomeEmail)
 */
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import {
  DESK_LABELS,
  EVENT_KIND_LABELS,
  type NotifyTopic,
  type PortalEvent,
  type PortalMember,
  PortalRole,
  type PortalSettings,
  isStaffRole,
} from "@niltv/types";
import type { SQSBatchItemFailure, SQSHandler } from "aws-lambda";
import { z } from "zod";
import { convMessageKey, getDocClient, portalEventKey, portalRequestKey, postingKey } from "../../lib/db";
import { claimPushSlot, queueSummary } from "../../lib/portal/activity";
import { resolveAudience } from "../../lib/portal/audience";
import {
  type ConvMeta,
  type Membership,
  getConv,
  getMemberships,
  inbox,
  memberSubs,
  summarize,
  teamLabel,
} from "../../lib/portal/conversations";
import { type PortalEmail, formatWhen, sendEmail } from "../../lib/portal/emails";
import { deskRecipients, deskStaff, getMember, getMembers, getSettings, listMembers } from "../../lib/portal/members";
import type { PortalNotice } from "../../lib/portal/notify";
import {
  LAST_MINUTE_MS,
  type SummaryNote,
  cadenceFor,
  localDay,
  messageTopic,
  shouldPush,
  validZone,
} from "../../lib/portal/prefs";
import { type PushPayload, listDevices, pushTo } from "../../lib/portal/push";

const table = (): string => process.env.TABLE_NAME ?? "";

/** Recipients up to this many get the app badge count in the push (it costs an inbox read each). */
const BADGE_RECIPIENT_LIMIT = 25;
/** Members handled at once for one notice. */
const FANOUT = 8;

async function getRow(key: { PK: string; SK: string }): Promise<Record<string, unknown> | undefined> {
  const out = await getDocClient().send(new GetCommand({ TableName: table(), Key: key }));
  return out.Item as Record<string, unknown> | undefined;
}

/** Run `fn` for every item, a few at a time. One member failing never stops the rest. */
async function forEachMember<T>(items: readonly T[], fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const item = items[next++]!;
      try {
        await fn(item);
      } catch (err) {
        console.error("portal-notify: one recipient failed", err);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(FANOUT, items.length) }, worker));
}

const clip = (text: string, max: number): string => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/* ── The two outside channels ──────────────────────────────────────────────── */

interface Reach {
  settings: PortalSettings;
  now: Date;
}

/** Push to one member when their cadence, quiet hours, a recent visit and the daily cap allow it. */
async function maybePush(member: PortalMember, topic: NotifyTopic, payload: Omit<PushPayload, "at">, reach: Reach): Promise<void> {
  if (!reach.settings.webPush) return;
  const zone = validZone(member.timezone);
  const cadence = cadenceFor(member, topic);
  if (!shouldPush({ cadence, topic, now: reach.now, zone, lastSeenAt: member.lastSeenAt })) return;
  const devices = await listDevices(member.sub);
  if (devices.length === 0) return;
  if (topic !== "direct" && !(await claimPushSlot(member.sub, localDay(reach.now, zone)))) return;
  await pushTo(member.sub, { ...payload, at: reach.now.toISOString() }, devices);
}

/** Count the activity toward the member's summary email, unless the topic is off for them. */
async function maybeQueue(member: PortalMember, topic: NotifyTopic, at: Date, reach: Reach, note?: SummaryNote): Promise<void> {
  if (!reach.settings.activityEmails) return;
  const cadence = cadenceFor(member, topic);
  if (cadence === "off") return;
  await queueSummary(member, { at, cadence, ...(note ? { note } : {}) });
}

/** Unread total for the app icon, when it is cheap enough to work out. */
async function badgeFor(member: PortalMember, cheap: boolean): Promise<number | undefined> {
  if (!cheap) return undefined;
  const threads = await inbox(member);
  return threads.filter((t) => !t.muted).reduce((sum, t) => sum + t.unread, 0);
}

/* ── Messages ──────────────────────────────────────────────────────────────── */

const StoredMessageRow = z.object({
  authorSub: z.string(),
  authorName: z.string(),
  authorRole: PortalRole,
  seq: z.number(),
  body: z.string(),
  at: z.string(),
  hidden: z.boolean().default(false),
  mentions: z.array(z.string()).default([]),
  important: z.boolean().default(false),
});
type StoredMessageRow = z.infer<typeof StoredMessageRow>;

function messagePush(
  member: PortalMember,
  meta: ConvMeta,
  membership: Membership | undefined,
  msg: StoredMessageRow,
  mentioned: boolean,
): Omit<PushPayload, "at"> {
  const view = summarize(meta, member, membership);
  const author = isStaffRole(msg.authorRole) && !isStaffRole(member.role) ? teamLabel(meta) : msg.authorName;
  const unread = Math.max(1, view.unread);
  const mention = mentioned && meta.kind !== "desk";
  const body = member.notify.previews
    ? `${author}${mention ? " mentioned you" : ""}: ${clip(msg.body, 140)}`
    : mention
      ? `${author} mentioned you`
      : unread > 1
        ? `${unread} new messages`
        : `New message from ${author}`;
  return { title: view.title, body, url: `/messages/${encodeURIComponent(meta.id)}`, tag: `conv-${meta.id}` };
}

const importantEmail = (meta: ConvMeta): PortalEmail => ({
  subject: "Important announcement from NIL TV",
  heading: "Important announcement",
  lead: "NIL TV posted an important announcement in the portal.",
  button: { label: "Read it", path: `/messages/${encodeURIComponent(meta.id)}` },
  tail: "You get this because NIL TV marked this announcement important. Choose what reaches you in Account.",
});

async function messageNotice(convId: string, messageId: string, reach: Reach): Promise<void> {
  if (!reach.settings.activityEmails && !reach.settings.webPush) return;
  const meta = await getConv(convId);
  const parsed = StoredMessageRow.safeParse((await getRow(convMessageKey(convId, messageId))) ?? {});
  if (!meta || !parsed.success || parsed.data.hidden) return;
  const msg = parsed.data;
  const at = new Date(msg.at);

  if (meta.kind === "desk" && meta.desk && !isStaffRole(msg.authorRole)) {
    // Into a desk: push the staff who answer it. Their email is the hourly desk alert.
    const staff = await deskStaff(meta.desk);
    const markers = await getMemberships(staff.map((m) => m.sub), meta.id);
    await forEachMember(staff, async (m) => {
      if ((markers.get(m.sub)?.lastReadSeq ?? 0) >= msg.seq) return;
      await maybePush(
        m,
        "direct",
        {
          title: msg.authorName,
          body: m.notify.previews ? clip(msg.body, 140) : `New message to ${DESK_LABELS[meta.desk!]}`,
          url: `/messages/${encodeURIComponent(meta.id)}`,
          tag: `conv-${meta.id}`,
          ...(reach.settings.webPush
            ? await badgeFor(m, staff.length <= BADGE_RECIPIENT_LIMIT).then((badge) => (badge === undefined ? {} : { badge }))
            : {}),
        },
        reach,
      );
    });
    return;
  }

  const audience = meta.kind === "desk" ? (meta.personSub ? [meta.personSub] : []) : await memberSubs(meta.id);
  const subs = [...new Set([...audience, ...msg.mentions])].filter((sub) => sub !== msg.authorSub);
  if (subs.length === 0) return;
  const [members, states] = await Promise.all([getMembers(subs), getMemberships(subs, meta.id)]);
  const mentions = new Set(msg.mentions);
  const important = msg.important && meta.scope?.type === "announcements" && isStaffRole(msg.authorRole);
  const cheapBadge = subs.length <= BADGE_RECIPIENT_LIMIT;

  await forEachMember(subs, async (sub) => {
    const member = members.get(sub);
    if (!member || member.status !== "active") return;
    const state = states.get(sub);
    const mentioned = mentions.has(sub);
    // A mention gets through a muted thread; nothing else does.
    if ((state?.muted && !mentioned) || (state && state.lastReadSeq >= msg.seq)) return;
    const topic = messageTopic(meta, mentioned);
    if (important && reach.settings.activityEmails && cadenceFor(member, topic) !== "off") {
      await sendEmail(member.email, importantEmail(meta));
    } else {
      await maybeQueue(member, topic, at, reach);
    }
    const badge = reach.settings.webPush ? await badgeFor(member, cheapBadge) : undefined;
    await maybePush(member, topic, { ...messagePush(member, meta, state, msg, mentioned), ...(badge === undefined ? {} : { badge }) }, reach);
  });
}

/* ── Postings ──────────────────────────────────────────────────────────────── */

const PostingRow = z.object({
  id: z.string(),
  title: z.string(),
  about: z.string().default(""),
  status: z.enum(["open", "closed"]),
  createdBySub: z.string(),
});

async function postingNotice(notice: Extract<PortalNotice, { type: `posting.${string}` }>, reach: Reach): Promise<void> {
  const posting = PostingRow.safeParse((await getRow(postingKey(notice.postingId))) ?? {});
  if (!posting.success) return;
  const p = posting.data;
  const path = `/postings/${encodeURIComponent(p.id)}`;
  const tag = `posting-${p.id}`;

  if (notice.type === "posting.new") {
    if (p.status !== "open") return;
    if (!reach.settings.activityEmails && !reach.settings.webPush) return;
    const athletes = (await listMembers()).filter((m) => m.role === "athlete" && m.status === "active");
    await forEachMember(athletes, async (m) => {
      await maybeQueue(m, "postings", reach.now, reach);
      await maybePush(m, "postings", { title: "New internal posting", body: p.title, url: path, tag }, reach);
    });
    return;
  }

  const person = await getMember(notice.personSub);
  if (!person) return;
  if (notice.type === "posting.interest") {
    // Staff work queue: always on.
    const poster = await getMember(p.createdBySub);
    const to =
      poster && poster.status === "active"
        ? [poster.email]
        : ((await getSettings()).deskEmails.content ?? []);
    for (const address of to) {
      await sendEmail(address, {
        subject: `${person.name} is interested in ${p.title}`,
        heading: "New interest",
        lead: `${person.name} wants to be considered for ${p.title}. This posting needs your approval.`,
        button: { label: "Review interest", path },
        tail: "You get this because you posted this in the NIL TV Portal with approval on.",
      });
    }
    return;
  }

  const interest = await getRow({ PK: `POSTING#${p.id}`, SK: `INTEREST#${person.sub}` });
  const status = interest?.["status"];
  if (status !== "approved" && status !== "declined") return;
  if (person.status !== "active") return;
  const approved = status === "approved";
  await maybeQueue(person, "direct", reach.now, reach, {
    topic: "direct",
    text: approved ? `You're approved for ${p.title}` : `An update on ${p.title}`,
    path,
    at: reach.now.toISOString(),
  });
  await maybePush(person, "direct", { title: approved ? "You're approved" : "Posting update", body: p.title, url: path, tag }, reach);
}

/* ── Schedule ──────────────────────────────────────────────────────────────── */

const EventRow = z.object({
  id: z.string(),
  title: z.string(),
  kind: z.enum(["gaming", "stream", "shoot", "meeting", "other"]),
  status: z.enum(["poll", "set", "cancelled"]),
  options: z.array(z.object({ id: z.string(), startsAt: z.string(), endsAt: z.string().optional() })),
  lockedOptionId: z.string().optional(),
  audience: z.any(),
  location: z.string().optional(),
});

/** Starts within LAST_MINUTE_MS from now (and has not long passed). */
const isLastMinute = (iso: string | undefined, now: Date): boolean => {
  if (!iso) return false;
  const delta = Date.parse(iso) - now.getTime();
  return delta < LAST_MINUTE_MS && delta > -6 * 60 * 60 * 1000;
};

async function eventNotice(notice: Extract<PortalNotice, { type: `event.${string}` }>, reach: Reach): Promise<void> {
  if (!reach.settings.activityEmails && !reach.settings.webPush) return;
  const parsed = EventRow.safeParse((await getRow(portalEventKey(notice.eventId))) ?? {});
  if (!parsed.success) return;
  const e = parsed.data;
  const invitees = (await resolveAudience(e.audience as PortalEvent["audience"])).filter((m) => m.status === "active");
  const locked = e.options.find((o) => o.id === e.lockedOptionId);
  const kind = EVENT_KIND_LABELS[e.kind];
  const path = `/schedule/${encodeURIComponent(e.id)}`;
  const tag = `event-${e.id}`;
  const previous = notice.type === "event.changed" ? notice.previousStartsAt : undefined;
  const urgent =
    (notice.type === "event.cancelled" && e.status !== "poll" && isLastMinute(locked?.startsAt, reach.now)) ||
    (notice.type === "event.changed" && (isLastMinute(locked?.startsAt, reach.now) || isLastMinute(previous, reach.now)));

  await forEachMember(invitees, async (m) => {
    const when = locked ? formatWhen(locked.startsAt, m.timezone) : undefined;
    let push: Omit<PushPayload, "at">;
    let note: SummaryNote | undefined;
    let email: PortalEmail | undefined;
    if (notice.type === "event.cancelled") {
      push = { title: "Cancelled", body: e.title, url: "/schedule", tag };
      note = { topic: "schedule", text: `Cancelled: ${e.title}`, path: "/schedule", at: reach.now.toISOString() };
      email = {
        subject: `Cancelled: ${e.title}`,
        heading: "Cancelled",
        lead: `${e.title} is cancelled.${when ? ` It was set for ${when}.` : ""}`,
        button: { label: "Open the schedule", path: "/schedule" },
      };
    } else if (notice.type === "event.changed") {
      push = { title: "New time", body: `${e.title}${when ? `, ${when}` : ""}`, url: path, tag };
      note = { topic: "schedule", text: `New time: ${e.title}${when ? `, ${when}` : ""}`, path, at: reach.now.toISOString() };
      email = {
        subject: `New time: ${e.title}`,
        heading: "New time",
        lead: `${e.title} moved${when ? ` to ${when}` : ""}.${e.location ? ` Where: ${e.location}.` : ""}`,
        button: { label: "See the details", path },
      };
    } else if (e.status === "poll") {
      push = { title: "Pick your times", body: e.title, url: path, tag };
    } else {
      push = {
        title: notice.type === "event.locked" ? "Time set" : kind,
        body: `${e.title}${when ? `, ${when}` : ""}`,
        url: path,
        tag,
      };
    }
    if (urgent && email && reach.settings.activityEmails && cadenceFor(m, "schedule") !== "off") {
      await sendEmail(m.email, email);
    } else {
      // Polls and unanswered events are worked out fresh when the summary goes out.
      await maybeQueue(m, "schedule", reach.now, reach, note);
    }
    await maybePush(m, "schedule", push, reach);
  });
}

/* ── Staff work queues and welcome (always on) ─────────────────────────────── */

const RequestRow = z.object({ id: z.string(), personName: z.string(), body: z.string() });

async function requestNotice(requestId: string): Promise<void> {
  const parsed = RequestRow.safeParse((await getRow(portalRequestKey(requestId))) ?? {});
  if (!parsed.success) return;
  const settings = await getSettings();
  const to = await deskRecipients("support", settings);
  const targets = to.length > 0 ? to : [settings.supportEmail];
  for (const address of new Set(targets)) {
    await sendEmail(address, {
      subject: `Page change request from ${parsed.data.personName}`,
      heading: "Page change request",
      lead: `${parsed.data.personName} asked for a change to their athlete page.`,
      paragraphs: [parsed.data.body],
      button: { label: "Open requests", path: "/requests" },
      tail: "You get this because you answer the Athlete support desk in the NIL TV Portal.",
    });
  }
}

const TOPIC_LABELS: Record<string, string> = {
  account: "Account",
  payments: "Payments",
  content: "Content",
  technical: "Technical problem",
  other: "Other",
};

async function helpNotice(notice: Extract<PortalNotice, { type: "help" }>): Promise<void> {
  const member = await getMember(notice.sub);
  if (!member) return;
  const settings = await getSettings();
  await sendEmail(
    settings.supportEmail,
    {
      subject: `Portal help (${TOPIC_LABELS[notice.topic] ?? notice.topic}): ${member.name}`,
      heading: "Help request",
      lead: `${member.name} (${member.role}, ${member.email}) sent this from the portal Help form. Reply to this email to answer them.`,
      paragraphs: [notice.message],
      tail: "Sent from the NIL TV Portal Help form.",
    },
    member.email,
  );
}

async function welcomeNotice(sub: string): Promise<void> {
  const member = await getMember(sub);
  if (!member || member.status !== "active") return;
  const lead =
    member.role === "athlete"
      ? "Your NIL TV Portal is ready. Message the team, check the schedule and see internal postings."
      : member.role === "guest"
        ? "NIL TV added you to the portal so you can see the schedule and chat with the team."
        : "You now have staff access to the NIL TV Portal.";
  await sendEmail(member.email, {
    subject: "Your NIL TV Portal is ready",
    heading: "Welcome in",
    lead,
    paragraphs: ["Sign in with your niltv.com account."],
    button: { label: "Open the portal", path: "/" },
    tail: "You get this because NIL TV gave your niltv.com account portal access.",
  });
}

export async function handleNotice(notice: PortalNotice, now: Date = new Date()): Promise<void> {
  switch (notice.type) {
    case "message":
      return messageNotice(notice.convId, notice.messageId, { settings: await getSettings(), now });
    case "posting.new":
    case "posting.interest":
    case "posting.decision":
      return postingNotice(notice, { settings: await getSettings(), now });
    case "event.new":
    case "event.locked":
    case "event.changed":
    case "event.cancelled":
      return eventNotice(notice, { settings: await getSettings(), now });
    case "request.new":
      return requestNotice(notice.requestId);
    case "help":
      return helpNotice(notice);
    case "welcome":
      return welcomeNotice(notice.sub);
  }
}

export const handler: SQSHandler = async (event) => {
  const batchItemFailures: SQSBatchItemFailure[] = [];
  for (const record of event.Records) {
    try {
      await handleNotice(JSON.parse(record.body) as PortalNotice);
    } catch (err) {
      console.error("portal-notify: notice failed", record.messageId, err);
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures };
};
