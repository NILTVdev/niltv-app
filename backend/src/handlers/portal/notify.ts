/**
 * portal-notify (SQS consumer): turns portal notices (lib/portal/notify.ts)
 * into emails. Who hears about what:
 *
 *   desk message from an athlete or guest   the desk's addresses (Settings),
 *                                           else staff who answer that desk
 *   desk message from staff                 the athlete or guest
 *   group / channel message                 members who keep that email on
 *   new posting                             athletes who keep posting emails on
 *   interest in an approval posting         the staff member who posted it
 *   approve / decline                       the athlete
 *   new event, time locked, cancelled       the invitees
 *   page change request                     the Athlete support desk
 *   help form                               the support address, reply-to the sender
 *
 * Message emails skip anyone who already read the message, has the thread
 * muted, or got an email about the same thread in the last 30 minutes.
 */
import { BatchGetCommand, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import {
  DESK_LABELS,
  EVENT_KIND_LABELS,
  type NotifyPrefs,
  type PortalEvent,
  type PortalMember,
  PortalRole,
  desksFor,
  isStaffRole,
} from "@niltv/types";
import type { SQSBatchItemFailure, SQSHandler } from "aws-lambda";
import { z } from "zod";
import {
  convMailedKey,
  convMemberKey,
  convMessageKey,
  getDocClient,
  portalEventKey,
  portalRequestKey,
  postingKey,
} from "../../lib/db";
import { resolveAudience } from "../../lib/portal/audience";
import { type ConvMeta, getConv, memberSubs, parseMembership } from "../../lib/portal/conversations";
import { type PortalEmail, formatWhen, sendEmail } from "../../lib/portal/emails";
import { getMember, getMembers, getSettings, listMembers } from "../../lib/portal/members";
import type { PortalNotice } from "../../lib/portal/notify";

const table = (): string => process.env.TABLE_NAME ?? "";

export const MAIL_WINDOW_MS = 30 * 60 * 1000;

/** Claim the email slot for (target, thread); false when one went out inside the window. */
export async function claimMailSlot(target: string, convId: string, now: Date = new Date()): Promise<boolean> {
  try {
    await getDocClient().send(
      new PutCommand({
        TableName: table(),
        Item: { ...convMailedKey(target, convId), at: now.toISOString() },
        ConditionExpression: "attribute_not_exists(PK) OR #at < :cutoff",
        ExpressionAttributeNames: { "#at": "at" },
        ExpressionAttributeValues: { ":cutoff": new Date(now.getTime() - MAIL_WINDOW_MS).toISOString() },
      }),
    );
    return true;
  } catch (err) {
    if ((err as { name?: string }).name === "ConditionalCheckFailedException") return false;
    throw err;
  }
}

async function getRow(key: { PK: string; SK: string }): Promise<Record<string, unknown> | undefined> {
  const out = await getDocClient().send(new GetCommand({ TableName: table(), Key: key }));
  return out.Item as Record<string, unknown> | undefined;
}

const wants = (m: PortalMember, pref: keyof NotifyPrefs): boolean => m.status === "active" && m.notify[pref];

/* ── Messages ──────────────────────────────────────────────────────────────── */

const StoredMessageRow = z.object({
  authorSub: z.string(),
  authorName: z.string(),
  authorRole: PortalRole,
  seq: z.number(),
  hidden: z.boolean().default(false),
});

/** Staff who answer a desk, used when Settings names no address for it. */
async function deskStaffEmails(desk: keyof typeof DESK_LABELS): Promise<string[]> {
  return (await listMembers())
    .filter((m) => m.status === "active" && isStaffRole(m.role) && m.desks.includes(desk) && desksFor(m.role).includes(desk))
    .map((m) => m.email);
}

async function messageNotice(convId: string, messageId: string): Promise<void> {
  const meta = await getConv(convId);
  const parsed = StoredMessageRow.safeParse((await getRow(convMessageKey(convId, messageId))) ?? {});
  if (!meta || !parsed.success || parsed.data.hidden) return;
  const msg = parsed.data;
  const threadPath = `/messages/${encodeURIComponent(meta.id)}`;

  if (meta.kind === "desk" && meta.desk) {
    const desk = meta.desk;
    if (!isStaffRole(msg.authorRole)) {
      // Into the desk: email the desk's inbox addresses once per window.
      if (!(await claimMailSlot(`desk-${desk}`, meta.id))) return;
      const settings = await getSettings();
      const to = settings.deskEmails[desk]?.length ? settings.deskEmails[desk]! : await deskStaffEmails(desk);
      for (const address of new Set(to)) {
        await sendEmail(address, {
          subject: `${msg.authorName} wrote to ${DESK_LABELS[desk]}`,
          heading: "New desk message",
          lead: `${msg.authorName} sent a message to the ${DESK_LABELS[desk]} desk.`,
          button: { label: "Open the thread", path: threadPath },
          tail: `You get this because you answer the ${DESK_LABELS[desk]} desk in the NIL TV Portal.`,
        });
      }
      return;
    }
    // Out of the desk: email the athlete or guest.
    if (meta.personSub) {
      await emailMembersAboutMessage(meta, msg.seq, [meta.personSub], "directMessages", {
        subject: `New message from the NIL TV ${DESK_LABELS[desk]} desk`,
        heading: "New message",
        lead: `The ${DESK_LABELS[desk]} desk sent you a message in the NIL TV Portal.`,
        button: { label: "Read it", path: threadPath },
      });
    }
    return;
  }

  const recipients = (await memberSubs(meta.id)).filter((sub) => sub !== msg.authorSub);
  if (meta.kind === "group") {
    await emailMembersAboutMessage(meta, msg.seq, recipients, "groupMessages", {
      subject: `New message in ${meta.title}`,
      heading: "New group message",
      lead: `There is a new message in ${meta.title}.`,
      button: { label: "Open the group", path: threadPath },
    });
    return;
  }
  const announcement = meta.scope?.type === "announcements";
  await emailMembersAboutMessage(meta, msg.seq, recipients, announcement ? "announcements" : "channelMessages", {
    subject: announcement ? "New announcement from NIL TV" : `New post in ${meta.title}`,
    heading: announcement ? "New announcement" : "New channel post",
    lead: announcement ? "NIL TV posted a new announcement in the portal." : `There is a new post in ${meta.title}.`,
    button: { label: announcement ? "Read it" : "Open the channel", path: threadPath },
  });
}

async function emailMembersAboutMessage(
  meta: ConvMeta,
  seq: number,
  subs: readonly string[],
  pref: keyof NotifyPrefs,
  email: PortalEmail,
): Promise<void> {
  if (subs.length === 0) return;
  const members = await getMembers(subs);
  const states = new Map<string, ReturnType<typeof parseMembership>>();
  for (let i = 0; i < subs.length; i += 100) {
    const keys = subs.slice(i, i + 100).map((sub) => ({ ...convMemberKey(sub, meta.id) }));
    const res = await getDocClient().send(new BatchGetCommand({ RequestItems: { [table()]: { Keys: keys } } }));
    for (const item of res.Responses?.[table()] ?? []) {
      states.set(String(item["PK"]).slice("USER#".length), parseMembership(item));
    }
  }
  for (const sub of subs) {
    const member = members.get(sub);
    if (!member || !wants(member, pref)) continue;
    const state = states.get(sub);
    if (state?.muted || (state && state.lastReadSeq >= seq)) continue;
    if (!(await claimMailSlot(sub, meta.id))) continue;
    await sendEmail(member.email, email);
  }
}

/* ── Postings, events, requests, help, welcome ─────────────────────────────── */

const PostingRow = z.object({
  id: z.string(),
  title: z.string(),
  about: z.string().default(""),
  status: z.enum(["open", "closed"]),
  createdBySub: z.string(),
});

async function postingNotice(notice: Extract<PortalNotice, { type: `posting.${string}` }>): Promise<void> {
  const posting = PostingRow.safeParse((await getRow(postingKey(notice.postingId))) ?? {});
  if (!posting.success) return;
  const p = posting.data;
  const path = `/postings/${encodeURIComponent(p.id)}`;

  if (notice.type === "posting.new") {
    if (p.status !== "open") return;
    const athletes = (await listMembers()).filter((m) => m.role === "athlete" && wants(m, "postings"));
    for (const athlete of athletes) {
      await sendEmail(athlete.email, {
        subject: `New internal posting: ${p.title}`,
        heading: "New posting",
        lead: p.title,
        paragraphs: p.about ? [p.about] : [],
        button: { label: "See the posting", path },
      });
    }
    return;
  }

  const person = await getMember(notice.personSub);
  if (!person) return;
  if (notice.type === "posting.interest") {
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
  await sendEmail(person.email, {
    subject: status === "approved" ? `You're approved for ${p.title}` : `An update on ${p.title}`,
    heading: status === "approved" ? "You're approved" : "Posting update",
    lead:
      status === "approved"
        ? `NIL TV approved your interest in ${p.title}. Staff will follow up with next steps.`
        : `NIL TV went another way on ${p.title} this time. Thanks for raising your hand.`,
    button: { label: "See the posting", path },
  });
}

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

async function eventNotice(notice: Extract<PortalNotice, { type: `event.${string}` }>): Promise<void> {
  const parsed = EventRow.safeParse((await getRow(portalEventKey(notice.eventId))) ?? {});
  if (!parsed.success) return;
  const e = parsed.data;
  const invitees = (await resolveAudience(e.audience as PortalEvent["audience"])).filter((m) => wants(m, "schedule"));
  const locked = e.options.find((o) => o.id === e.lockedOptionId);
  const kind = EVENT_KIND_LABELS[e.kind];
  const path = `/schedule/${encodeURIComponent(e.id)}`;

  for (const m of invitees) {
    const when = locked ? formatWhen(locked.startsAt, m.timezone) : undefined;
    let email: PortalEmail;
    if (notice.type === "event.cancelled") {
      email = {
        subject: `Cancelled: ${e.title}`,
        heading: "Cancelled",
        lead: `${e.title} is cancelled.${when ? ` It was set for ${when}.` : ""}`,
        button: { label: "Open the schedule", path: "/schedule" },
      };
    } else if (e.status === "poll") {
      email = {
        subject: `Pick your times: ${e.title}`,
        heading: "When works for you?",
        lead: `NIL TV is planning a ${kind.toLowerCase()}: ${e.title}. Pick every time that works for you.`,
        button: { label: "Pick times", path },
      };
    } else {
      email = {
        subject: notice.type === "event.locked" ? `Time set: ${e.title}` : `${kind}: ${e.title}`,
        heading: notice.type === "event.locked" ? "Time is set" : "You're invited",
        lead: `${e.title}${when ? ` is ${when}` : ""}.${e.location ? ` Where: ${e.location}.` : ""}`,
        button: { label: "RSVP", path },
      };
    }
    await sendEmail(m.email, email);
  }
}

const RequestRow = z.object({ id: z.string(), personName: z.string(), body: z.string() });

async function requestNotice(requestId: string): Promise<void> {
  const parsed = RequestRow.safeParse((await getRow(portalRequestKey(requestId))) ?? {});
  if (!parsed.success) return;
  const settings = await getSettings();
  const to = settings.deskEmails.support?.length ? settings.deskEmails.support : await deskStaffEmails("support");
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

export async function handleNotice(notice: PortalNotice): Promise<void> {
  switch (notice.type) {
    case "message":
      return messageNotice(notice.convId, notice.messageId);
    case "posting.new":
    case "posting.interest":
    case "posting.decision":
      return postingNotice(notice);
    case "event.new":
    case "event.locked":
    case "event.cancelled":
      return eventNotice(notice);
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
