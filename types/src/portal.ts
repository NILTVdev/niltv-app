/**
 * NIL TV Portal contract (portal.niltv.com): the signed-in workspace for
 * athletes, guests and staff. Every request and response shape the portal
 * API speaks lives here, and so does the permission table, so the server
 * check and the client menu read the same rules.
 *
 * Conversations use the CONV# model from the app messaging plan, so the
 * mobile app can read the same threads later.
 */
import { z } from "zod";
import { IsoDate } from "./primitives";

/* ── Roles, desks, reference lists ─────────────────────────────────────────── */

export const PortalRole = z.enum(["athlete", "guest", "staff", "admin"]);
export type PortalRole = z.infer<typeof PortalRole>;

/**
 * active   = can sign in to the portal
 * ready    = an accepted athlete synced from onboarding, waiting to be enabled
 * disabled = access removed (row kept so history keeps its name)
 */
export const PortalMemberStatus = z.enum(["active", "ready", "disabled"]);
export type PortalMemberStatus = z.infer<typeof PortalMemberStatus>;

/** Shared staff inboxes athletes and guests write to. */
export const Desk = z.enum(["content", "support", "payments"]);
export type Desk = z.infer<typeof Desk>;

export const DESK_LABELS: Record<Desk, string> = {
  content: "Content team",
  support: "Athlete support",
  payments: "Payments",
};

/** Campus channels, as listed on the athlete signup form. Key = channel slug. */
export const CAMPUS_CHANNELS: Record<string, { name: string; school: string }> = {
  truebluetv: { name: "TrueBlue TV", school: "Duke" },
  chapelhilltv: { name: "Chapel Hill TV", school: "North Carolina" },
  redpacktv: { name: "Red Pack TV", school: "NC State" },
  dorecitytv: { name: "Dore City TV", school: "Vanderbilt" },
  starkvilletv: { name: "Starkville TV", school: "Mississippi State" },
  collegestationtv: { name: "College Station TV", school: "Texas A&M" },
  brazostv: { name: "Brazos TV", school: "Baylor" },
  goldendometv: { name: "Golden Dome TV", school: "Notre Dame" },
  goldsalemtv: { name: "Gold Salem TV", school: "Wake Forest" },
  saltcitytv: { name: "Salt City TV", school: "Syracuse" },
};

/** Sports exactly as the athlete signup form lists them. Each one gets its own chat. */
export const PORTAL_SPORTS = [
  "Men's Cross Country", "Women's Cross Country", "Field Hockey", "Football", "Women's Soccer",
  "Men's Soccer", "Women's Volleyball", "Water Polo", "Men's Swim and Dive", "Women's Swim and Dive",
  "Men's Basketball", "Women's Basketball", "Bowling", "Fencing", "Men's Gymnastics",
  "Women's Gymnastics", "Men's Ice Hockey", "Women's Ice Hockey", "Rifle", "Skiing",
  "Men's Track and Field", "Women's Track and Field", "Men's Wrestling", "Women's Wrestling", "Baseball",
  "Beach Volleyball", "Men's Golf", "Women's Golf", "Men's Lacrosse", "Women's Lacrosse", "Rowing",
  "Softball", "Men's Tennis", "Women's Tennis", "Men's Volleyball", "Women's Water Polo", "Triathlon",
  "Cheer", "Dance", "Other",
] as const;

/* ── Permissions (one table for the server check and the client menu) ─────── */

export const PORTAL_PERMISSIONS = {
  /** post in Announcements, hide any message */
  moderate: ["staff", "admin"],
  /** read and answer the content and support desks */
  answerDesks: ["staff", "admin"],
  /** read and answer the payments desk */
  answerPayments: ["admin"],
  /** create and edit group chats */
  manageGroups: ["admin"],
  /** create, edit, lock and cancel schedule events */
  manageEvents: ["staff", "admin"],
  /** availability across the roster */
  viewAvailability: ["staff", "admin"],
  /** create and edit postings, see and decide on interest */
  managePostings: ["staff", "admin"],
  /** see postings and mark interest */
  viewPostings: ["athlete", "staff", "admin"],
  /** athlete list with contact details and onboarding state */
  viewRoster: ["staff", "admin"],
  /** add and remove guests */
  manageGuests: ["staff", "admin"],
  /** change roles, enable athletes, add staff, edit settings */
  manageAccess: ["admin"],
  /** request a change to your own athlete page */
  requestPageChange: ["athlete"],
  /** work the page change request queue */
  manageRequests: ["staff", "admin"],
  /** Stripe status for every athlete */
  viewPayouts: ["admin"],
  /** the athlete Payments, My posts and Refer screens */
  athleteTools: ["athlete"],
} as const satisfies Record<string, readonly PortalRole[]>;

export type PortalPermission = keyof typeof PORTAL_PERMISSIONS;

export function portalCan(role: PortalRole | undefined, permission: PortalPermission): boolean {
  if (!role) return false;
  return (PORTAL_PERMISSIONS[permission] as readonly PortalRole[]).includes(role);
}

/** Desks a role may write to (athletes and guests) or answer (staff and admins). */
export function desksFor(role: PortalRole): Desk[] {
  switch (role) {
    case "athlete":
      return ["content", "support", "payments"];
    case "guest":
      return ["content", "support"];
    case "staff":
      return ["content", "support"];
    case "admin":
      return ["content", "support", "payments"];
  }
}

export const isStaffRole = (role: PortalRole | undefined): boolean => role === "staff" || role === "admin";

/* ── Members ───────────────────────────────────────────────────────────────── */

export const NotifyPrefs = z.object({
  directMessages: z.boolean().default(true),
  groupMessages: z.boolean().default(true),
  channelMessages: z.boolean().default(false),
  announcements: z.boolean().default(true),
  schedule: z.boolean().default(true),
  postings: z.boolean().default(true),
});
export type NotifyPrefs = z.infer<typeof NotifyPrefs>;

export const StripeState = z.enum(["none", "pending", "complete", "international"]);
export type StripeState = z.infer<typeof StripeState>;

/** A portal account (USER#{sub} / PORTAL). Staff see every field; nobody else sees another member's row. */
export const PortalMember = z.object({
  sub: z.string().min(1),
  email: z.string(),
  name: z.string(),
  role: PortalRole,
  status: PortalMemberStatus,
  /** staff and admins: the desks whose new messages email them */
  desks: z.array(Desk).default([]),
  /** athletes: campus channel slug from the signup form (CAMPUS_CHANNELS key) */
  campus: z.string().optional(),
  school: z.string().optional(),
  /** athletes: sport exactly as picked on the signup form */
  sport: z.string().optional(),
  year: z.string().optional(),
  instagram: z.string().optional(),
  /** the athlete's ath-* profile on niltv.com, when the roster has one */
  profileId: z.string().optional(),
  /** dashboard applications.id this athlete came from */
  applicationId: z.number().int().optional(),
  stripe: StripeState.optional(),
  /** guests: who they are to us ("Gaming partner", "Photographer") */
  note: z.string().optional(),
  /** fields staff set by hand; the onboarding sync leaves these alone */
  edited: z.array(z.string()).default([]),
  timezone: z.string().optional(),
  notify: NotifyPrefs.default({}),
  createdAt: IsoDate,
  updatedAt: IsoDate.optional(),
  lastSeenAt: IsoDate.optional(),
});
export type PortalMember = z.infer<typeof PortalMember>;

/** The public face of a member inside the portal: no contact details. */
export const PortalPerson = z.object({
  sub: z.string(),
  name: z.string(),
  role: PortalRole,
  campus: z.string().optional(),
  sport: z.string().optional(),
});
export type PortalPerson = z.infer<typeof PortalPerson>;

export const PortalMeResponse = z.object({
  member: PortalMember,
  unreadMessages: z.number().int().nonnegative(),
});
export type PortalMeResponse = z.infer<typeof PortalMeResponse>;

export const PortalMeUpdate = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  timezone: z.string().max(64).optional(),
  notify: NotifyPrefs.partial().optional(),
  /** staff and admins only */
  desks: z.array(Desk).optional(),
});
export type PortalMeUpdate = z.infer<typeof PortalMeUpdate>;

export const MemberListResponse = z.object({ members: z.array(PortalMember) });
export type MemberListResponse = z.infer<typeof MemberListResponse>;

/** Add someone who already has a niltv.com account. */
export const MemberAddRequest = z.object({
  email: z.string().trim().toLowerCase().email(),
  role: PortalRole,
  name: z.string().trim().min(1).max(80).optional(),
  note: z.string().trim().max(120).optional(),
  desks: z.array(Desk).optional(),
  campus: z.string().optional(),
  sport: z.string().optional(),
});
export type MemberAddRequest = z.infer<typeof MemberAddRequest>;

export const MemberUpdateRequest = z.object({
  role: PortalRole.optional(),
  status: PortalMemberStatus.optional(),
  name: z.string().trim().min(1).max(80).optional(),
  note: z.string().trim().max(120).optional(),
  desks: z.array(Desk).optional(),
  campus: z.string().nullable().optional(),
  sport: z.string().nullable().optional(),
});
export type MemberUpdateRequest = z.infer<typeof MemberUpdateRequest>;

/** PORTAL#CONFIG / META — admin settings. */
export const PortalSettings = z.object({
  /** who gets the email when a message lands in each desk */
  deskEmails: z.record(Desk, z.array(z.string().email())).default({}),
  /** where the Help form goes */
  supportEmail: z.string().email().default("support@niltv.com"),
  /** off while testing: accepted athletes wait as "ready" until an admin enables them */
  autoEnableAthletes: z.boolean().default(false),
  /** send the welcome email when an athlete is enabled */
  welcomeEmail: z.boolean().default(false),
});
export type PortalSettings = z.infer<typeof PortalSettings>;

/* ── Conversations ─────────────────────────────────────────────────────────── */

export const ConvKind = z.enum(["channel", "group", "desk"]);
export type ConvKind = z.infer<typeof ConvKind>;

export const ChannelScope = z.discriminatedUnion("type", [
  z.object({ type: z.literal("announcements") }),
  z.object({ type: z.literal("everyone") }),
  z.object({ type: z.literal("campus"), campus: z.string() }),
  z.object({ type: z.literal("sport"), sport: z.string() }),
]);
export type ChannelScope = z.infer<typeof ChannelScope>;

export const ConversationSummary = z.object({
  id: z.string(),
  kind: ConvKind,
  title: z.string(),
  /** one line under the title: "Every athlete", "Private between you and the Content team" */
  about: z.string().default(""),
  scope: ChannelScope.optional(),
  desk: Desk.optional(),
  /** desk threads: the athlete or guest on the other side */
  person: PortalPerson.optional(),
  /** only staff may post */
  staffOnly: z.boolean().default(false),
  memberCount: z.number().int().nonnegative().default(0),
  seq: z.number().int().nonnegative().default(0),
  lastMessageAt: IsoDate.optional(),
  lastPreview: z.string().optional(),
  unread: z.number().int().nonnegative().default(0),
  muted: z.boolean().default(false),
});
export type ConversationSummary = z.infer<typeof ConversationSummary>;

export const InboxResponse = z.object({ conversations: z.array(ConversationSummary) });
export type InboxResponse = z.infer<typeof InboxResponse>;

export const ConversationDetail = ConversationSummary.extend({
  /** groups and desks list everyone; channels list staff-only for size */
  members: z.array(PortalPerson).default([]),
});
export type ConversationDetail = z.infer<typeof ConversationDetail>;

export const PortalMessage = z.object({
  id: z.string(),
  convId: z.string(),
  seq: z.number().int().nonnegative(),
  /** what this viewer sees: staff post as "NIL TV Team" or their desk to everyone but staff */
  authorName: z.string(),
  authorRole: PortalRole,
  /** staff viewers only: the person behind a team or desk post */
  staffName: z.string().optional(),
  mine: z.boolean(),
  body: z.string(),
  at: IsoDate,
  hidden: z.boolean().default(false),
});
export type PortalMessage = z.infer<typeof PortalMessage>;

export const MessagesResponse = z.object({
  messages: z.array(PortalMessage),
  /** pass as ?before= for the next older page; absent at the start of the thread */
  before: z.string().optional(),
});
export type MessagesResponse = z.infer<typeof MessagesResponse>;

export const SendMessageRequest = z.object({
  clientMsgId: z.string().min(8).max(64),
  body: z.string().trim().min(1).max(4000),
});
export type SendMessageRequest = z.infer<typeof SendMessageRequest>;

export const ReadRequest = z.object({ seq: z.number().int().nonnegative() });

/** Staff hide or unhide one message. */
export const HideMessageRequest = z.object({ hidden: z.boolean().default(true) });
export type HideMessageRequest = z.infer<typeof HideMessageRequest>;

/** The reply to writes with nothing to return; `duplicate` = a resent message that had already landed. */
export const PortalAck = z.object({ status: z.literal("ok"), duplicate: z.boolean().optional() });
export type PortalAck = z.infer<typeof PortalAck>;
export const MuteRequest = z.object({ muted: z.boolean() });

/** Athletes and guests open a desk thread for themselves; staff open one with a person. */
export const OpenDeskRequest = z.object({
  desk: Desk,
  personSub: z.string().optional(),
});
export type OpenDeskRequest = z.infer<typeof OpenDeskRequest>;

export const GroupUpsertRequest = z.object({
  title: z.string().trim().min(1).max(60),
  about: z.string().trim().max(200).default(""),
  memberSubs: z.array(z.string()).max(500).default([]),
});
export type GroupUpsertRequest = z.infer<typeof GroupUpsertRequest>;

/* ── Schedule ──────────────────────────────────────────────────────────────── */

export const PortalEventKind = z.enum(["gaming", "stream", "shoot", "meeting", "other"]);
export type PortalEventKind = z.infer<typeof PortalEventKind>;

export const EVENT_KIND_LABELS: Record<PortalEventKind, string> = {
  gaming: "Gaming session",
  stream: "Live stream",
  shoot: "Content shoot",
  meeting: "Meeting",
  other: "Event",
};

/** Who an event or poll is for. "everyone" = every athlete plus staff. */
export const Audience = z.discriminatedUnion("type", [
  z.object({ type: z.literal("everyone") }),
  z.object({ type: z.literal("campus"), campus: z.string() }),
  z.object({ type: z.literal("sport"), sport: z.string() }),
  z.object({ type: z.literal("group"), convId: z.string() }),
  z.object({ type: z.literal("people"), subs: z.array(z.string()).min(1).max(500) }),
]);
export type Audience = z.infer<typeof Audience>;

export const PortalEventStatus = z.enum(["poll", "set", "cancelled"]);
export type PortalEventStatus = z.infer<typeof PortalEventStatus>;

export const TimeOption = z.object({
  id: z.string(),
  startsAt: IsoDate,
  endsAt: IsoDate.optional(),
});
export type TimeOption = z.infer<typeof TimeOption>;

export const RsvpStatus = z.enum(["going", "maybe", "no"]);
export type RsvpStatus = z.infer<typeof RsvpStatus>;

export const PortalEvent = z.object({
  id: z.string(),
  title: z.string(),
  kind: PortalEventKind,
  description: z.string().default(""),
  location: z.string().optional(),
  streamUrl: z.string().optional(),
  status: PortalEventStatus,
  /** poll: the times to pick from; set: one option, the locked time */
  options: z.array(TimeOption),
  /** set events: the locked option */
  lockedOptionId: z.string().optional(),
  audience: Audience,
  audienceLabel: z.string(),
  createdByName: z.string(),
  createdAt: IsoDate,
  updatedAt: IsoDate.optional(),
  myVotes: z.array(z.string()).default([]),
  myRsvp: RsvpStatus.optional(),
  /** staff only: who picked each option */
  votes: z.array(z.object({ optionId: z.string(), people: z.array(PortalPerson) })).optional(),
  /** staff only: replies to a set event */
  rsvps: z.array(z.object({ person: PortalPerson, status: RsvpStatus })).optional(),
  invitedCount: z.number().int().nonnegative().default(0),
});
export type PortalEvent = z.infer<typeof PortalEvent>;

export const EventsResponse = z.object({ events: z.array(PortalEvent) });
export type EventsResponse = z.infer<typeof EventsResponse>;

export const EventUpsertRequest = z.object({
  title: z.string().trim().min(1).max(100),
  kind: PortalEventKind,
  description: z.string().trim().max(2000).default(""),
  location: z.string().trim().max(200).optional(),
  streamUrl: z.string().trim().url().max(500).optional(),
  audience: Audience,
  /** one time = a set event; two or more = a time poll */
  options: z.array(z.object({ startsAt: IsoDate, endsAt: IsoDate.optional() })).min(1).max(12),
});
export type EventUpsertRequest = z.infer<typeof EventUpsertRequest>;

export const EventActionRequest = z.discriminatedUnion("action", [
  z.object({ action: z.literal("lock"), optionId: z.string() }),
  z.object({ action: z.literal("cancel") }),
  z.object({ action: z.literal("vote"), optionIds: z.array(z.string()).max(12) }),
  z.object({ action: z.literal("rsvp"), status: RsvpStatus }),
]);
export type EventActionRequest = z.infer<typeof EventActionRequest>;

export const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export const DAY_BLOCKS = ["morning", "afternoon", "evening", "late"] as const;
export const DAY_BLOCK_LABELS: Record<(typeof DAY_BLOCKS)[number], string> = {
  morning: "Morning",
  afternoon: "Afternoon",
  evening: "Evening",
  late: "Late night",
};

/** "thu-evening": a weekday and a block of the day, in the member's own time zone. */
export const AvailabilitySlot = z
  .string()
  .regex(/^(mon|tue|wed|thu|fri|sat|sun)-(morning|afternoon|evening|late)$/);

export const Availability = z.object({
  slots: z.array(AvailabilitySlot).max(28),
  timezone: z.string().max(64).optional(),
  updatedAt: IsoDate.optional(),
});
export type Availability = z.infer<typeof Availability>;

export const AvailabilityHeatmap = z.object({
  /** members in the audience who have set their availability */
  responded: z.number().int().nonnegative(),
  invited: z.number().int().nonnegative(),
  cells: z.array(z.object({ slot: AvailabilitySlot, count: z.number().int(), names: z.array(z.string()) })),
});
export type AvailabilityHeatmap = z.infer<typeof AvailabilityHeatmap>;

/* ── Internal Postings ─────────────────────────────────────────────────────── */

export const InterestStatus = z.enum(["interested", "approved", "declined"]);
export type InterestStatus = z.infer<typeof InterestStatus>;

export const Posting = z.object({
  id: z.string(),
  title: z.string(),
  /** one line for the card */
  about: z.string().default(""),
  /** the full write-up */
  details: z.string().default(""),
  /** on: staff approve each interested athlete and get an email for each one */
  requiresApproval: z.boolean().default(false),
  status: z.enum(["open", "closed"]),
  createdByName: z.string(),
  createdAt: IsoDate,
  updatedAt: IsoDate.optional(),
  interestCount: z.number().int().nonnegative().default(0),
  myInterest: InterestStatus.optional(),
  /** staff only */
  interest: z
    .array(z.object({ person: PortalPerson, email: z.string().optional(), status: InterestStatus, at: IsoDate }))
    .optional(),
});
export type Posting = z.infer<typeof Posting>;

export const PostingsResponse = z.object({ postings: z.array(Posting) });
export type PostingsResponse = z.infer<typeof PostingsResponse>;

export const PostingUpsertRequest = z.object({
  title: z.string().trim().min(1).max(100),
  about: z.string().trim().max(200).default(""),
  details: z.string().trim().max(5000).default(""),
  requiresApproval: z.boolean().default(false),
  status: z.enum(["open", "closed"]).default("open"),
});
export type PostingUpsertRequest = z.infer<typeof PostingUpsertRequest>;

export const PostingActionRequest = z.discriminatedUnion("action", [
  z.object({ action: z.literal("interest"), interested: z.boolean() }),
  z.object({ action: z.literal("decide"), personSub: z.string(), status: z.enum(["approved", "declined"]) }),
]);
export type PostingActionRequest = z.infer<typeof PostingActionRequest>;

/* ── Page change requests and Help ─────────────────────────────────────────── */

export const PortalRequestStatus = z.enum(["open", "done", "declined"]);
export type PortalRequestStatus = z.infer<typeof PortalRequestStatus>;

export const PortalRequest = z.object({
  id: z.string(),
  kind: z.literal("page_change"),
  body: z.string(),
  link: z.string().optional(),
  status: PortalRequestStatus,
  person: PortalPerson,
  createdAt: IsoDate,
  staffNote: z.string().optional(),
  resolvedAt: IsoDate.optional(),
  resolvedByName: z.string().optional(),
});
export type PortalRequest = z.infer<typeof PortalRequest>;

export const PortalRequestsResponse = z.object({ requests: z.array(PortalRequest) });
export type PortalRequestsResponse = z.infer<typeof PortalRequestsResponse>;

export const PortalRequestCreate = z.object({
  body: z.string().trim().min(5).max(4000),
  link: z.string().trim().url().max(500).optional(),
});
export type PortalRequestCreate = z.infer<typeof PortalRequestCreate>;

export const PortalRequestUpdate = z.object({
  status: PortalRequestStatus,
  staffNote: z.string().trim().max(1000).optional(),
});
export type PortalRequestUpdate = z.infer<typeof PortalRequestUpdate>;

export const HelpTopic = z.enum(["account", "payments", "content", "technical", "other"]);
export type HelpTopic = z.infer<typeof HelpTopic>;

export const HelpRequest = z.object({
  topic: HelpTopic.default("other"),
  message: z.string().trim().min(5).max(5000),
});
export type HelpRequest = z.infer<typeof HelpRequest>;

/* ── My posts ──────────────────────────────────────────────────────────────── */

export const MyPost = z.object({
  id: z.string(),
  title: z.string(),
  posterUrl: z.string().optional(),
  channelId: z.string().optional(),
  publishedAt: IsoDate.optional(),
  views: z.number().int().nonnegative().default(0),
});
export type MyPost = z.infer<typeof MyPost>;

export const MyPostsResponse = z.object({
  /** false when no niltv.com profile is linked to this athlete yet */
  linked: z.boolean(),
  posts: z.array(MyPost),
});
export type MyPostsResponse = z.infer<typeof MyPostsResponse>;

/* ── Errors ────────────────────────────────────────────────────────────────── */

export const PortalErrorCode = z.enum([
  "NOT_MEMBER", // signed in, but no active portal access
  "FORBIDDEN", // role does not allow this
  "NO_ACCOUNT", // add by email: no niltv.com account with that email
  "STAFF_ONLY", // post in a staff-only channel
  "CONFLICT",
]);
export type PortalErrorCode = z.infer<typeof PortalErrorCode>;
