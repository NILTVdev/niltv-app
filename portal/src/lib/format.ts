/**
 * Small display helpers and the plain-word labels the screens share.
 * Pure: no DOM, no React.
 */
import {
  CAMPUS_CHANNELS,
  type HelpTopic,
  type InterestStatus,
  type NotifyCadence,
  type NotifyTopic,
  NotifyTopic as NotifyTopicEnum,
  type PortalMemberStatus,
  type PortalPermission,
  type PortalRequestStatus,
  type PortalRole,
  type RsvpStatus,
  type StripeState,
} from "@niltv/types";
import type { ZodIssue } from "zod";

export const initials = (name: string): string =>
  name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0] ?? "")
    .join("")
    .slice(0, 2)
    .toUpperCase() || "?";

export const plural = (n: number, word: string, many = `${word}s`): string => `${n} ${n === 1 ? word : many}`;

export const firstName = (name: string): string => name.trim().split(/\s+/)[0] ?? name;

const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
export const compactNumber = (n: number): string => compact.format(n);

/** Campus channel name for a slug, e.g. "TrueBlue TV". Channel names are ours and show alone. */
export const campusName = (slug: string | undefined): string =>
  slug ? (CAMPUS_CHANNELS[slug]?.name ?? slug) : "";

/** A school never renders bare (docs/CONVENTIONS.md, School naming). */
export const schoolLabel = (school: string | undefined): string => (school ? `${school} NIL Student Athletes` : "");

export const CAMPUS_OPTIONS = Object.entries(CAMPUS_CHANNELS)
  .map(([slug, c]) => ({ slug, name: c.name }))
  .sort((a, b) => a.name.localeCompare(b.name));

export const ROLE_LABELS: Record<PortalRole, string> = {
  athlete: "Athlete",
  guest: "Guest",
  staff: "Staff",
  admin: "Admin",
};

export const MEMBER_STATUS: Record<PortalMemberStatus, { label: string; tone: Tone }> = {
  active: { label: "Active", tone: "ok" },
  ready: { label: "Waiting", tone: "warn" },
  disabled: { label: "No access", tone: "neutral" },
};

export const STRIPE_STATUS: Record<StripeState, { label: string; tone: Tone }> = {
  none: { label: "Not set up", tone: "bad" },
  pending: { label: "In progress", tone: "warn" },
  complete: { label: "Connected", tone: "ok" },
  international: { label: "International", tone: "info" },
};

export const INTEREST_STATUS: Record<InterestStatus, { label: string; tone: Tone }> = {
  interested: { label: "Interested", tone: "warn" },
  approved: { label: "Approved", tone: "ok" },
  declined: { label: "Declined", tone: "bad" },
};

export const REQUEST_STATUS: Record<PortalRequestStatus, { label: string; tone: Tone }> = {
  open: { label: "Open", tone: "warn" },
  done: { label: "Done", tone: "ok" },
  declined: { label: "Declined", tone: "bad" },
};

export const RSVP_LABELS: Record<RsvpStatus, string> = { going: "Going", maybe: "Maybe", no: "Can't go" };

export const HELP_TOPICS: Record<HelpTopic, string> = {
  account: "My account",
  payments: "Payments",
  content: "Content",
  technical: "Something is broken",
  other: "Something else",
};

export const CADENCE_LABELS: Record<NotifyCadence, string> = {
  now: "Right away",
  daily: "Daily summary",
  off: "Off",
};

export const NOTIFY_LABELS: Record<NotifyTopic, { label: string; help: string }> = {
  direct: { label: "Messages to you", help: "Desk replies, @mentions and posting decisions." },
  groups: { label: "Group chats", help: "New messages in your groups." },
  announcements: { label: "Announcements", help: "Posts from the NIL TV team." },
  channels: { label: "Campus and sport chats", help: "Every athlete, campus and sport channels. These never send a phone notification." },
  schedule: { label: "Schedule", help: "Time polls, set times, changes and cancellations." },
  postings: { label: "Internal postings", help: "New postings you can raise your hand for." },
};

/** The notification topics a role picks a cadence for, in order, with that role's wording. */
export function notifyTopicsFor(role: PortalRole): { topic: NotifyTopic; label: string; help: string }[] {
  const row = (topic: NotifyTopic, over: Partial<{ label: string; help: string }> = {}) => ({
    topic,
    ...NOTIFY_LABELS[topic],
    ...over,
  });
  switch (role) {
    case "athlete":
      return NotifyTopicEnum.options.map((t) => row(t));
    case "guest":
      // Guests have no postings, so no posting decisions either.
      return [row("direct", { help: "Desk replies and @mentions." }), row("groups"), row("schedule")];
    case "staff":
    case "admin":
      return [
        row("direct", {
          label: "Desk messages and @mentions",
          help: "New messages in the desks you answer, and @mentions of you.",
        }),
        row("groups"),
        row("schedule"),
      ];
  }
}

/** The tab title with the unread count in front: "(3) Messages | NIL TV Portal". */
export const unreadTitle = (title: string, unread: number): string =>
  unread > 0 ? `(${unread > 99 ? "99+" : unread}) ${title}` : title;

/** Plain-word rows for the access matrix on Team & access. */
export const PERMISSION_LABELS: Record<PortalPermission, string> = {
  moderate: "Post in Announcements and hide messages",
  answerDesks: "Read and answer the Content team and Athlete support desks",
  answerPayments: "Read and answer the Payments desk",
  manageGroups: "Create and edit group chats",
  manageEvents: "Create, edit, lock and cancel events",
  viewAvailability: "See availability across the roster",
  managePostings: "Create postings and decide on interest",
  viewPostings: "See postings and mark interest",
  viewRoster: "See the athlete list, onboarding and Stripe status",
  manageGuests: "Add and remove guests",
  manageAccess: "Change roles, enable athletes, add staff, edit settings",
  requestPageChange: "Request a change to their own athlete page",
  manageRequests: "Work the page change request queue",
  viewPayouts: "Open the Payouts screen",
  athleteTools: "My posts, Payments and Refer friends",
};

export type Tone = "ok" | "warn" | "bad" | "info" | "neutral";

const humanize = (key: string): string => {
  const words = key.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/** The first zod issue as one plain sentence ("Link must be a full link starting with https://."). */
export function describeIssues(issues: readonly ZodIssue[]): string {
  const issue = issues[0];
  if (!issue) return "Check the form and try again.";
  const key = [...issue.path].reverse().find((p): p is string => typeof p === "string");
  const field = key ? humanize(key) : "This";
  switch (issue.code) {
    case "too_small":
      return issue.type === "array" ? `${field} needs at least ${String(issue.minimum)}.` : `${field} is too short.`;
    case "too_big":
      return issue.type === "array" ? `${field} has too many entries.` : `${field} is too long.`;
    case "invalid_string":
      if (issue.validation === "url") return `${field} must be a full link starting with https://.`;
      if (issue.validation === "email") return `${field} must be an email address.`;
      if (issue.validation === "datetime") return `${field} needs a date and time.`;
      return `${field} is not valid.`;
    case "invalid_type":
      return issue.received === "undefined" ? `${field} is required.` : `${field} is not valid.`;
    default:
      return `${field} is not valid.`;
  }
}

/** True for http(s) URLs only; a form check before the contract's url() check. */
export function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

/** Comma or newline separated emails into a clean list. */
export const splitEmails = (value: string): string[] =>
  value
    .split(/[,\n;]/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
