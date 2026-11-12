/**
 * Portal messaging on the CONV# model from the app messaging plan.
 *
 *   CONV#{id} / META           the thread: kind, title, seq, last message
 *   CONV#{id} / MSG#{ulid}     one message
 *   CONV#{id} / CMID#{id}      retry guard for a client message id
 *   USER#{sub} / CONV#{id}     membership + read state (GSI1 mirror lists members)
 *
 * Three kinds of thread:
 *   channel  Announcements, All athletes, one per campus channel, one per
 *            sport. Athletes join automatically from their roster fields.
 *   group    hand-picked by an admin; the only threads guests share.
 *   desk     one per person per desk (Content team, Athlete support,
 *            Payments). Staff answer every thread of their desks.
 *
 * Staff never hold channel or group memberships: they see every channel and
 * group, and keep a read marker row (marker = true, no GSI mirror) per
 * thread they open. A send writes three items in one transaction: the
 * message, the retry guard, and the META seq bump guarded by the seq it read.
 */
import {
  BatchGetCommand,
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  CAMPUS_CHANNELS,
  type ChannelScope,
  type ConvKind,
  type ConversationSummary,
  DESK_LABELS,
  type Desk,
  type PortalMember,
  type PortalMessage,
  type PortalPerson,
  type PortalRole,
  MENTION_LIMIT,
  desksFor,
  isStaffRole,
} from "@niltv/types";
import {
  CONVS_ALL_GSI1PK,
  CONV_MEMBER_SK_PREFIX,
  CONV_MSG_SK_PREFIX,
  GSI1,
  backoffDelayMs,
  convClientMsgKey,
  convKey,
  convMemberGsi,
  convMemberKey,
  convMessageKey,
  deskGsi1Pk,
  getDocClient,
} from "../db";
import { slugify, ulid } from "./ids";

const table = (): string => process.env.TABLE_NAME ?? "";

const isCcf = (err: unknown): boolean => (err as { name?: string }).name === "ConditionalCheckFailedException";

/* ── Shapes as stored ──────────────────────────────────────────────────────── */

export interface ConvMeta {
  id: string;
  kind: ConvKind;
  title: string;
  about: string;
  scope?: ChannelScope;
  desk?: Desk;
  personSub?: string;
  personName?: string;
  personRole?: PortalRole;
  staffOnly: boolean;
  memberCount: number;
  seq: number;
  lastMessageAt?: string;
  lastPreview?: string;
  /** desk threads: the first message from the athlete or guest that staff have not answered yet */
  waitingSince?: string;
  createdAt: string;
  createdBySub?: string;
}

export interface Membership {
  convId: string;
  kind: ConvKind;
  lastReadSeq: number;
  lastReadAt?: string;
  muted: boolean;
  joinedAt?: string;
  /** staff read marker: not a membership, never mirrored to GSI1 */
  marker: boolean;
  /** seq of the latest message that @mentions this person */
  mentionSeq: number;
}

export interface StoredMessage {
  id: string;
  convId: string;
  seq: number;
  authorSub: string;
  authorName: string;
  authorRole: PortalRole;
  body: string;
  at: string;
  hidden: boolean;
  mentions: string[];
  important: boolean;
}

const num = (v: unknown, d = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : d);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);

export function parseConv(item: Record<string, unknown> | undefined): ConvMeta | undefined {
  if (!item || typeof item["id"] !== "string" || typeof item["kind"] !== "string") return undefined;
  return {
    id: item["id"],
    kind: item["kind"] as ConvKind,
    title: str(item["title"]) ?? "",
    about: str(item["about"]) ?? "",
    ...(item["scope"] ? { scope: item["scope"] as ChannelScope } : {}),
    ...(str(item["desk"]) ? { desk: item["desk"] as Desk } : {}),
    ...(str(item["personSub"]) ? { personSub: item["personSub"] as string } : {}),
    ...(str(item["personName"]) ? { personName: item["personName"] as string } : {}),
    ...(str(item["personRole"]) ? { personRole: item["personRole"] as PortalRole } : {}),
    staffOnly: item["staffOnly"] === true,
    memberCount: num(item["memberCount"]),
    seq: num(item["seq"]),
    ...(str(item["lastMessageAt"]) ? { lastMessageAt: item["lastMessageAt"] as string } : {}),
    ...(str(item["lastPreview"]) ? { lastPreview: item["lastPreview"] as string } : {}),
    ...(str(item["waitingSince"]) ? { waitingSince: item["waitingSince"] as string } : {}),
    createdAt: str(item["createdAt"]) ?? new Date(0).toISOString(),
    ...(str(item["createdBySub"]) ? { createdBySub: item["createdBySub"] as string } : {}),
  };
}

export function parseMembership(item: Record<string, unknown>): Membership | undefined {
  const convId = str(item["convId"]);
  if (!convId) return undefined;
  return {
    convId,
    kind: (str(item["kind"]) ?? "channel") as ConvKind,
    lastReadSeq: num(item["lastReadSeq"]),
    ...(str(item["lastReadAt"]) ? { lastReadAt: item["lastReadAt"] as string } : {}),
    muted: item["muted"] === true,
    ...(str(item["joinedAt"]) ? { joinedAt: item["joinedAt"] as string } : {}),
    marker: item["marker"] === true,
    mentionSeq: num(item["mentionSeq"]),
  };
}

function parseMessage(item: Record<string, unknown>): StoredMessage | undefined {
  if (typeof item["id"] !== "string" || typeof item["body"] !== "string") return undefined;
  return {
    id: item["id"],
    convId: str(item["convId"]) ?? "",
    seq: num(item["seq"]),
    authorSub: str(item["authorSub"]) ?? "",
    authorName: str(item["authorName"]) ?? "Member",
    authorRole: (str(item["authorRole"]) ?? "athlete") as PortalRole,
    body: item["body"],
    at: str(item["at"]) ?? new Date(0).toISOString(),
    hidden: item["hidden"] === true,
    mentions: Array.isArray(item["mentions"])
      ? (item["mentions"] as unknown[]).filter((v): v is string => typeof v === "string")
      : [],
    important: item["important"] === true,
  };
}

/** META item with the right GSI1 listing: desks by last activity, the rest by kind and title. */
export function convItem(meta: ConvMeta): Record<string, unknown> {
  const gsi =
    meta.kind === "desk" && meta.desk
      ? { GSI1PK: deskGsi1Pk(meta.desk), GSI1SK: meta.lastMessageAt ?? meta.createdAt }
      : { GSI1PK: CONVS_ALL_GSI1PK, GSI1SK: `${meta.kind}#${meta.title.toLowerCase()}#${meta.id}` };
  return { ...convKey(meta.id), ...gsi, ...meta };
}

/* ── Channels ──────────────────────────────────────────────────────────────── */

export function channelId(scope: ChannelScope): string {
  switch (scope.type) {
    case "announcements":
      return "ch-announcements";
    case "everyone":
      return "ch-everyone";
    case "campus":
      return `ch-campus-${slugify(scope.campus)}`;
    case "sport":
      return `ch-sport-${slugify(scope.sport)}`;
  }
}

export function channelTitle(scope: ChannelScope): string {
  switch (scope.type) {
    case "announcements":
      return "Announcements";
    case "everyone":
      return "All athletes";
    case "campus":
      return CAMPUS_CHANNELS[scope.campus]?.name ?? scope.campus;
    case "sport":
      return scope.sport;
  }
}

export function channelAbout(scope: ChannelScope): string {
  switch (scope.type) {
    case "announcements":
      return "Every athlete. Only staff post here.";
    case "everyone":
      return "Every athlete on the roster.";
    case "campus": {
      const school = CAMPUS_CHANNELS[scope.campus]?.school;
      // Channel surfaces read "{School}’s Athletes" (docs/CONVENTIONS.md).
      return school ? `${school}’s Athletes. Joined automatically from your campus.` : "Joined automatically from your campus.";
    }
    case "sport":
      return `${scope.sport} on every campus. Joined automatically from your sport.`;
  }
}

/** The channels an active athlete belongs in. Guests and staff join none. */
export function channelScopesFor(member: PortalMember): ChannelScope[] {
  if (member.role !== "athlete" || member.status !== "active") return [];
  const scopes: ChannelScope[] = [{ type: "announcements" }, { type: "everyone" }];
  if (member.campus && CAMPUS_CHANNELS[member.campus]) scopes.push({ type: "campus", campus: member.campus });
  if (member.sport && member.sport !== "Other") scopes.push({ type: "sport", sport: member.sport });
  return scopes;
}

export async function getConv(convId: string): Promise<ConvMeta | undefined> {
  const out = await getDocClient().send(new GetCommand({ TableName: table(), Key: convKey(convId) }));
  return parseConv(out.Item);
}

/** Create a conversation if it does not exist; returns the stored META either way. */
async function ensureConv(meta: ConvMeta): Promise<ConvMeta> {
  try {
    await getDocClient().send(
      new PutCommand({ TableName: table(), Item: convItem(meta), ConditionExpression: "attribute_not_exists(PK)" }),
    );
    return meta;
  } catch (err) {
    if (!isCcf(err)) throw err;
    return (await getConv(meta.id)) ?? meta;
  }
}

export function ensureChannel(scope: ChannelScope, now: string = new Date().toISOString()): Promise<ConvMeta> {
  return ensureConv({
    id: channelId(scope),
    kind: "channel",
    title: channelTitle(scope),
    about: channelAbout(scope),
    scope,
    staffOnly: scope.type === "announcements",
    memberCount: 0,
    seq: 0,
    createdAt: now,
  });
}

/** Add a real membership (with the GSI1 mirror). No-op when already a member. */
export async function joinConversation(sub: string, meta: ConvMeta, now: string = new Date().toISOString()): Promise<boolean> {
  try {
    await getDocClient().send(
      new PutCommand({
        TableName: table(),
        Item: {
          ...convMemberKey(sub, meta.id),
          ...convMemberGsi(sub, meta.id),
          convId: meta.id,
          kind: meta.kind,
          // Start read at the current message so joining does not flood the inbox.
          lastReadSeq: meta.seq,
          muted: false,
          joinedAt: now,
          marker: false,
        },
        ConditionExpression: "attribute_not_exists(PK) OR marker = :true",
        ExpressionAttributeValues: { ":true": true },
      }),
    );
  } catch (err) {
    if (isCcf(err)) return false;
    throw err;
  }
  await getDocClient().send(
    new UpdateCommand({
      TableName: table(),
      Key: convKey(meta.id),
      UpdateExpression: "ADD memberCount :one",
      ExpressionAttributeValues: { ":one": 1 },
    }),
  );
  return true;
}

/** Remove a real membership. Read markers are left alone. */
export async function leaveConversation(sub: string, convId: string): Promise<boolean> {
  try {
    await getDocClient().send(
      new DeleteCommand({
        TableName: table(),
        Key: convMemberKey(sub, convId),
        ConditionExpression: "attribute_exists(PK) AND marker = :false",
        ExpressionAttributeValues: { ":false": false },
      }),
    );
  } catch (err) {
    if (isCcf(err)) return false;
    throw err;
  }
  await getDocClient().send(
    new UpdateCommand({
      TableName: table(),
      Key: convKey(convId),
      UpdateExpression: "ADD memberCount :minus",
      ConditionExpression: "attribute_exists(PK)",
      ExpressionAttributeValues: { ":minus": -1 },
    }),
  ).catch((err) => {
    if (!isCcf(err)) throw err;
  });
  return true;
}

/** Every membership and read-marker row of one person. */
export async function listMemberships(sub: string): Promise<Membership[]> {
  const out: Membership[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const page = await getDocClient().send(
      new QueryCommand({
        TableName: table(),
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :conv)",
        ExpressionAttributeValues: { ":pk": `USER#${sub}`, ":conv": CONV_MEMBER_SK_PREFIX },
        ExclusiveStartKey: startKey,
      }),
    );
    for (const item of page.Items ?? []) {
      const m = parseMembership(item);
      if (m) out.push(m);
    }
    startKey = page.LastEvaluatedKey;
  } while (startKey);
  return out;
}

/**
 * Bring an athlete's channel memberships in line with their roster fields:
 * join the channels they belong in, leave the ones they no longer do. Also
 * the cleanup path when someone is disabled or stops being an athlete.
 */
export async function syncChannelMemberships(member: PortalMember): Promise<{ joined: string[]; left: string[] }> {
  const desired = new Map(channelScopesFor(member).map((scope) => [channelId(scope), scope]));
  const current = (await listMemberships(member.sub)).filter((m) => m.kind === "channel" && !m.marker);
  const joined: string[] = [];
  const left: string[] = [];
  for (const m of current) {
    if (!desired.has(m.convId) && (await leaveConversation(member.sub, m.convId))) left.push(m.convId);
  }
  const have = new Set(current.map((m) => m.convId));
  for (const [id, scope] of desired) {
    if (have.has(id)) continue;
    const meta = await ensureChannel(scope);
    if (await joinConversation(member.sub, meta)) joined.push(id);
  }
  return { joined, left };
}

/** Leave every group too (used when access is removed). */
export async function leaveAllGroups(sub: string): Promise<void> {
  for (const m of await listMemberships(sub)) {
    if (m.kind === "group" && !m.marker) await leaveConversation(sub, m.convId);
  }
}

/* ── Desk threads ──────────────────────────────────────────────────────────── */

export const deskConvId = (desk: Desk, sub: string): string => `desk-${desk}-${sub}`;

/** Find or create the thread between one person and one desk. */
export async function openDeskThread(desk: Desk, person: PortalMember, now: string = new Date().toISOString()): Promise<ConvMeta> {
  const meta = await ensureConv({
    id: deskConvId(desk, person.sub),
    kind: "desk",
    title: DESK_LABELS[desk],
    about: `Private between ${person.name} and the ${DESK_LABELS[desk]} desk.`,
    desk,
    personSub: person.sub,
    personName: person.name,
    personRole: person.role,
    staffOnly: false,
    memberCount: 1,
    seq: 0,
    createdAt: now,
  });
  // The person's membership row puts the thread in their inbox (and is
  // checked like any membership). memberCount was set to 1 at create.
  await getDocClient()
    .send(
      new PutCommand({
        TableName: table(),
        Item: {
          ...convMemberKey(person.sub, meta.id),
          ...convMemberGsi(person.sub, meta.id),
          convId: meta.id,
          kind: "desk",
          lastReadSeq: meta.seq,
          muted: false,
          joinedAt: now,
          marker: false,
        },
        ConditionExpression: "attribute_not_exists(PK)",
      }),
    )
    .catch((err) => {
      if (!isCcf(err)) throw err;
    });
  return meta;
}

/* ── Groups ────────────────────────────────────────────────────────────────── */

export async function createGroup(
  input: { id: string; title: string; about: string; createdBySub: string },
  now: string = new Date().toISOString(),
): Promise<ConvMeta> {
  const meta: ConvMeta = {
    id: input.id,
    kind: "group",
    title: input.title,
    about: input.about,
    staffOnly: false,
    memberCount: 0,
    seq: 0,
    createdAt: now,
    createdBySub: input.createdBySub,
  };
  await getDocClient().send(
    new PutCommand({ TableName: table(), Item: convItem(meta), ConditionExpression: "attribute_not_exists(PK)" }),
  );
  return meta;
}

export async function updateGroupInfo(meta: ConvMeta, title: string, about: string): Promise<ConvMeta> {
  const next = { ...meta, title, about };
  const item = convItem(next);
  await getDocClient().send(
    new UpdateCommand({
      TableName: table(),
      Key: convKey(meta.id),
      UpdateExpression: "SET title = :t, about = :a, GSI1SK = :sk",
      ConditionExpression: "attribute_exists(PK)",
      ExpressionAttributeValues: { ":t": title, ":a": about, ":sk": item["GSI1SK"] },
    }),
  );
  return next;
}

/** Subs holding a real membership (the GSI1 mirror). */
export async function memberSubs(convId: string): Promise<string[]> {
  const subs: string[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const page = await getDocClient().send(
      new QueryCommand({
        TableName: table(),
        IndexName: GSI1,
        KeyConditionExpression: "GSI1PK = :pk AND begins_with(GSI1SK, :user)",
        ExpressionAttributeValues: { ":pk": `CONV#${convId}`, ":user": "USER#" },
        ExclusiveStartKey: startKey,
      }),
    );
    for (const item of page.Items ?? []) {
      const sk = item["GSI1SK"];
      if (typeof sk === "string") subs.push(sk.slice("USER#".length));
    }
    startKey = page.LastEvaluatedKey;
  } while (startKey);
  return subs;
}

/* ── Access ────────────────────────────────────────────────────────────────── */

export interface ConvAccess {
  read: boolean;
  post: boolean;
  staff: boolean;
}

export function convAccess(member: PortalMember, meta: ConvMeta, membership: Membership | undefined): ConvAccess {
  const staff = isStaffRole(member.role);
  if (meta.kind === "desk") {
    if (staff) {
      const ok = meta.desk !== undefined && desksFor(member.role).includes(meta.desk);
      return { read: ok, post: ok, staff };
    }
    const own = meta.personSub === member.sub;
    return { read: own, post: own, staff };
  }
  if (staff) return { read: true, post: true, staff };
  const isMember = membership !== undefined && !membership.marker;
  return { read: isMember, post: isMember && !meta.staffOnly, staff };
}

export async function getMembership(sub: string, convId: string): Promise<Membership | undefined> {
  const out = await getDocClient().send(new GetCommand({ TableName: table(), Key: convMemberKey(sub, convId) }));
  return out.Item ? parseMembership(out.Item) : undefined;
}

/* ── Messages ──────────────────────────────────────────────────────────────── */

const SEND_ATTEMPTS = 5;

/**
 * Send one message. Idempotent on clientMsgId: a retried send returns
 * `duplicate: true` and writes nothing. A concurrent send that moved `seq`
 * first makes this one re-read and retry.
 */
export async function sendMessage(
  author: PortalMember,
  convIdValue: string,
  input: { clientMsgId: string; body: string; mentions?: readonly string[]; important?: boolean },
  now: () => Date = () => new Date(),
): Promise<{ message?: StoredMessage; duplicate: boolean }> {
  for (let attempt = 0; attempt < SEND_ATTEMPTS; attempt++) {
    const meta = await getConv(convIdValue);
    if (!meta) throw new Error(`conversation ${convIdValue} not found`);
    const at = now().toISOString();
    const message: StoredMessage = {
      id: ulid(Date.parse(at)),
      convId: meta.id,
      seq: meta.seq + 1,
      authorSub: author.sub,
      authorName: author.name,
      authorRole: author.role,
      body: input.body,
      at,
      hidden: false,
      mentions: [...(input.mentions ?? [])],
      important: input.important === true,
    };
    const preview = input.body.replace(/\s+/g, " ").slice(0, 140);
    // Desk threads sort by activity, and wait on staff from the first
    // unanswered message until staff reply.
    const deskSk =
      meta.kind !== "desk"
        ? ""
        : isStaffRole(author.role)
          ? ", GSI1SK = :at REMOVE waitingSince"
          : ", GSI1SK = :at, waitingSince = if_not_exists(waitingSince, :at)";
    const { mentions, important, ...always } = message;
    const stored = { ...always, ...(mentions.length ? { mentions } : {}), ...(important ? { important } : {}) };
    try {
      await getDocClient().send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: table(),
                Item: { ...convClientMsgKey(meta.id, input.clientMsgId), messageId: message.id, at },
                ConditionExpression: "attribute_not_exists(PK)",
              },
            },
            {
              Put: {
                TableName: table(),
                Item: { ...convMessageKey(meta.id, message.id), ...stored },
                ConditionExpression: "attribute_not_exists(PK)",
              },
            },
            {
              Update: {
                TableName: table(),
                Key: convKey(meta.id),
                UpdateExpression: `SET seq = :next, lastMessageAt = :at, lastPreview = :preview${deskSk}`,
                ConditionExpression: "seq = :cur",
                ExpressionAttributeValues: { ":next": message.seq, ":cur": meta.seq, ":at": at, ":preview": preview },
              },
            },
          ],
        }),
      );
    } catch (err) {
      const reasons = (err as { CancellationReasons?: { Code?: string }[] }).CancellationReasons ?? [];
      if ((err as { name?: string }).name !== "TransactionCanceledException") throw err;
      if (reasons[0]?.Code === "ConditionalCheckFailed") return { duplicate: true };
      if (reasons[2]?.Code === "ConditionalCheckFailed" || reasons.some((r) => r.Code === "TransactionConflict")) {
        await new Promise((resolve) => setTimeout(resolve, backoffDelayMs(attempt)));
        continue;
      }
      throw err;
    }
    // Your own message is never unread for you.
    await markRead(author, meta, message.seq).catch((err) => console.warn("portal: self read marker failed", err));
    return { message, duplicate: false };
  }
  throw new Error("message send kept colliding; try again");
}

export async function listMessages(
  convIdValue: string,
  opts: { before?: string | undefined; after?: string | undefined; limit?: number | undefined },
): Promise<{ messages: StoredMessage[]; before?: string }> {
  const db = getDocClient();
  if (opts.after) {
    const out = await db.send(
      new QueryCommand({
        TableName: table(),
        KeyConditionExpression: "PK = :pk AND SK BETWEEN :from AND :to",
        ExpressionAttributeValues: {
          ":pk": `CONV#${convIdValue}`,
          ":from": `${CONV_MSG_SK_PREFIX}${opts.after}`,
          ":to": `${CONV_MSG_SK_PREFIX}~`,
        },
        ScanIndexForward: true,
        Limit: 200,
      }),
    );
    const messages = (out.Items ?? [])
      .map(parseMessage)
      .filter((m): m is StoredMessage => m !== undefined && m.id !== opts.after);
    return { messages };
  }
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 100);
  const out = await db.send(
    new QueryCommand({
      TableName: table(),
      KeyConditionExpression: opts.before
        ? "PK = :pk AND SK BETWEEN :from AND :to"
        : "PK = :pk AND begins_with(SK, :from)",
      ExpressionAttributeValues: opts.before
        ? { ":pk": `CONV#${convIdValue}`, ":from": CONV_MSG_SK_PREFIX, ":to": `${CONV_MSG_SK_PREFIX}${opts.before}` }
        : { ":pk": `CONV#${convIdValue}`, ":from": CONV_MSG_SK_PREFIX },
      ScanIndexForward: false,
      Limit: limit + 1,
    }),
  );
  const newestFirst = (out.Items ?? [])
    .map(parseMessage)
    .filter((m): m is StoredMessage => m !== undefined && m.id !== opts.before);
  const page = newestFirst.slice(0, limit);
  const more = newestFirst.length > limit;
  const oldest = page[page.length - 1];
  return { messages: page.reverse(), ...(more && oldest ? { before: oldest.id } : {}) };
}

/** How a staff post is signed for people who are not staff. */
export const teamLabel = (meta: ConvMeta): string =>
  meta.kind === "desk" && meta.desk ? DESK_LABELS[meta.desk] : "NIL TV Team";

/**
 * `emails` maps author sub to account email. Staff see it on desk threads, so
 * a member who borrowed someone else's name is still plain to see.
 */
export function presentMessage(
  message: StoredMessage,
  viewer: PortalMember,
  meta: ConvMeta,
  emails?: ReadonlyMap<string, string>,
): PortalMessage {
  const staffViewer = isStaffRole(viewer.role);
  const staffAuthor = isStaffRole(message.authorRole);
  const authorEmail = staffViewer && meta.kind === "desk" ? emails?.get(message.authorSub) : undefined;
  return {
    id: message.id,
    convId: message.convId,
    seq: message.seq,
    authorName: staffAuthor ? teamLabel(meta) : message.authorName,
    authorRole: message.authorRole,
    ...(staffViewer && staffAuthor ? { staffName: message.authorName } : {}),
    ...(authorEmail ? { authorEmail } : {}),
    mine: message.authorSub === viewer.sub,
    body: message.hidden && !staffViewer ? "" : message.body,
    at: message.at,
    hidden: message.hidden,
    mentions: message.hidden && !staffViewer ? [] : message.mentions,
    important: message.important,
  };
}

export async function setHidden(convIdValue: string, messageId: string, hidden: boolean, bySub: string): Promise<boolean> {
  try {
    await getDocClient().send(
      new UpdateCommand({
        TableName: table(),
        Key: convMessageKey(convIdValue, messageId),
        // "hidden" is a DynamoDB reserved word.
        UpdateExpression: "SET #hidden = :h, hiddenBy = :by, hiddenAt = :at",
        ConditionExpression: "attribute_exists(PK)",
        ExpressionAttributeNames: { "#hidden": "hidden" },
        ExpressionAttributeValues: { ":h": hidden, ":by": bySub, ":at": new Date().toISOString() },
      }),
    );
    return true;
  } catch (err) {
    if (isCcf(err)) return false;
    throw err;
  }
}

/* ── Read state ────────────────────────────────────────────────────────────── */

/**
 * Move the read marker forward (never back). Staff get a marker row on
 * first read; for everyone else the membership row must already exist.
 */
export async function markRead(member: PortalMember, meta: ConvMeta, seq: number): Promise<void> {
  const now = new Date().toISOString();
  const staffMarker = isStaffRole(member.role);
  try {
    await getDocClient().send(
      new UpdateCommand({
        TableName: table(),
        Key: convMemberKey(member.sub, meta.id),
        UpdateExpression: staffMarker
          ? "SET lastReadSeq = :seq, lastReadAt = :now, convId = :id, kind = :kind, marker = if_not_exists(marker, :true), muted = if_not_exists(muted, :false)"
          : "SET lastReadSeq = :seq, lastReadAt = :now",
        ConditionExpression: staffMarker
          ? "attribute_not_exists(lastReadSeq) OR lastReadSeq < :seq"
          : "attribute_exists(PK) AND lastReadSeq < :seq",
        ExpressionAttributeValues: staffMarker
          ? { ":seq": seq, ":now": now, ":id": meta.id, ":kind": meta.kind, ":true": true, ":false": false }
          : { ":seq": seq, ":now": now },
      }),
    );
  } catch (err) {
    if (!isCcf(err)) throw err;
  }
}

export async function setMuted(member: PortalMember, meta: ConvMeta, muted: boolean): Promise<void> {
  const staffMarker = isStaffRole(member.role);
  await getDocClient().send(
    new UpdateCommand({
      TableName: table(),
      Key: convMemberKey(member.sub, meta.id),
      UpdateExpression: staffMarker
        ? "SET muted = :m, convId = :id, kind = :kind, marker = if_not_exists(marker, :true), lastReadSeq = if_not_exists(lastReadSeq, :seq)"
        : "SET muted = :m",
      ...(staffMarker ? {} : { ConditionExpression: "attribute_exists(PK)" }),
      ExpressionAttributeValues: staffMarker
        ? { ":m": muted, ":id": meta.id, ":kind": meta.kind, ":true": true, ":seq": meta.seq }
        : { ":m": muted },
    }),
  );
}

/* ── @mentions ─────────────────────────────────────────────────────────────── */

/** Membership rows of many people in one conversation (missing = not a member). */
export async function getMemberships(subs: readonly string[], convIdValue: string): Promise<Map<string, Membership>> {
  const out = new Map<string, Membership>();
  const unique = [...new Set(subs)];
  for (let i = 0; i < unique.length; i += 100) {
    let keys = unique.slice(i, i + 100).map((sub) => ({ ...convMemberKey(sub, convIdValue) }) as Record<string, unknown>);
    for (let attempt = 0; keys.length > 0 && attempt < 5; attempt++) {
      const res = await getDocClient().send(new BatchGetCommand({ RequestItems: { [table()]: { Keys: keys } } }));
      for (const item of res.Responses?.[table()] ?? []) {
        const membership = parseMembership(item);
        if (membership) out.set(String(item["PK"]).slice("USER#".length), membership);
      }
      keys = (res.UnprocessedKeys?.[table()]?.Keys ?? []) as Record<string, unknown>[];
    }
  }
  return out;
}

/**
 * The mentions that can land: active people who can read this group or
 * channel. Never the author, never in a desk thread.
 */
export async function mentionable(
  meta: ConvMeta,
  authorSub: string,
  subs: readonly string[],
  people: Map<string, PortalMember>,
): Promise<PortalMember[]> {
  if (meta.kind === "desk") return [];
  const wanted = [...new Set(subs)].filter((sub) => sub !== authorSub).slice(0, MENTION_LIMIT);
  if (wanted.length === 0) return [];
  const memberships = await getMemberships(wanted, meta.id);
  return wanted
    .map((sub) => people.get(sub))
    .filter(
      (person): person is PortalMember =>
        person?.status === "active" && convAccess(person, meta, memberships.get(person.sub)).read,
    );
}

/**
 * Flag a mention on each person's membership row so their inbox shows it.
 * Staff may have no row in a channel yet: theirs is created as a read
 * marker that leaves exactly this message unread.
 */
export async function noteMentions(meta: ConvMeta, seq: number, people: readonly PortalMember[]): Promise<void> {
  for (const person of people) {
    const staff = isStaffRole(person.role);
    try {
      await getDocClient().send(
        new UpdateCommand({
          TableName: table(),
          Key: convMemberKey(person.sub, meta.id),
          UpdateExpression: staff
            ? "SET mentionSeq = :seq, convId = if_not_exists(convId, :id), kind = if_not_exists(kind, :kind), marker = if_not_exists(marker, :true), muted = if_not_exists(muted, :false), lastReadSeq = if_not_exists(lastReadSeq, :before)"
            : "SET mentionSeq = :seq",
          ...(staff ? {} : { ConditionExpression: "attribute_exists(PK)" }),
          ExpressionAttributeValues: staff
            ? { ":seq": seq, ":id": meta.id, ":kind": meta.kind, ":true": true, ":false": false, ":before": seq - 1 }
            : { ":seq": seq },
        }),
      );
    } catch (err) {
      if (!isCcf(err)) throw err;
    }
  }
}

/* ── Inbox ─────────────────────────────────────────────────────────────────── */

async function batchGetConvs(ids: readonly string[]): Promise<ConvMeta[]> {
  const out: ConvMeta[] = [];
  const unique = [...new Set(ids)];
  for (let i = 0; i < unique.length; i += 100) {
    let keys = unique.slice(i, i + 100).map((id) => ({ ...convKey(id) }) as Record<string, unknown>);
    for (let attempt = 0; keys.length > 0 && attempt < 5; attempt++) {
      const res = await getDocClient().send(new BatchGetCommand({ RequestItems: { [table()]: { Keys: keys } } }));
      for (const item of res.Responses?.[table()] ?? []) {
        const meta = parseConv(item);
        if (meta) out.push(meta);
      }
      keys = (res.UnprocessedKeys?.[table()]?.Keys ?? []) as Record<string, unknown>[];
    }
  }
  return out;
}

async function queryGsiConvs(pk: string, newestFirst: boolean, cap: number): Promise<ConvMeta[]> {
  const out: ConvMeta[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const page = await getDocClient().send(
      new QueryCommand({
        TableName: table(),
        IndexName: GSI1,
        KeyConditionExpression: "GSI1PK = :pk",
        ExpressionAttributeValues: { ":pk": pk },
        ScanIndexForward: !newestFirst,
        ExclusiveStartKey: startKey,
      }),
    );
    for (const item of page.Items ?? []) {
      const meta = parseConv(item);
      if (meta) out.push(meta);
    }
    startKey = page.LastEvaluatedKey;
  } while (startKey && out.length < cap);
  return out.slice(0, cap);
}

/** A desk's threads still waiting on a staff reply, oldest wait first. */
export async function waitingDeskThreads(desk: Desk): Promise<(ConvMeta & { waitingSince: string })[]> {
  return (await queryGsiConvs(deskGsi1Pk(desk), true, 1000))
    .filter((meta): meta is ConvMeta & { waitingSince: string } => meta.waitingSince !== undefined)
    .sort((a, b) => a.waitingSince.localeCompare(b.waitingSince));
}

const ROLE_LABELS: Record<PortalRole, string> = { athlete: "Athlete", guest: "Guest", staff: "Staff", admin: "Admin" };

export function summarize(meta: ConvMeta, viewer: PortalMember, membership: Membership | undefined): ConversationSummary {
  const staffViewer = isStaffRole(viewer.role);
  let title = meta.title;
  let about = meta.about;
  let person: PortalPerson | undefined;
  if (meta.kind === "desk" && meta.desk) {
    if (staffViewer) {
      title = meta.personName ?? "Member";
      about = `${ROLE_LABELS[meta.personRole ?? "athlete"]} to ${DESK_LABELS[meta.desk]}. Anyone on that desk can reply.`;
      person = { sub: meta.personSub ?? "", name: meta.personName ?? "Member", role: meta.personRole ?? "athlete" };
    } else {
      title = DESK_LABELS[meta.desk];
      about = `Private between you and the NIL TV ${DESK_LABELS[meta.desk].toLowerCase()} desk.`;
    }
  }
  // Staff who never opened a channel or group start at zero unread. Desk
  // threads count in full for each staff member until they read it
  // themselves: every read marker is per person.
  const baseline = membership ? membership.lastReadSeq : staffViewer && meta.kind !== "desk" ? meta.seq : 0;
  return {
    id: meta.id,
    kind: meta.kind,
    title,
    about,
    ...(meta.scope ? { scope: meta.scope } : {}),
    ...(meta.desk ? { desk: meta.desk } : {}),
    ...(person ? { person } : {}),
    staffOnly: meta.staffOnly,
    memberCount: meta.memberCount,
    seq: meta.seq,
    ...(meta.lastMessageAt ? { lastMessageAt: meta.lastMessageAt } : {}),
    ...(meta.lastPreview ? { lastPreview: meta.lastPreview } : {}),
    unread: Math.max(0, meta.seq - baseline),
    mentioned: (membership?.mentionSeq ?? 0) > baseline,
    muted: membership?.muted ?? false,
  };
}

const KIND_ORDER: Record<ConvKind, number> = { channel: 0, group: 1, desk: 2 };
const SCOPE_ORDER: Record<ChannelScope["type"], number> = { announcements: 0, everyone: 1, campus: 2, sport: 3 };

export function sortInbox(a: ConversationSummary, b: ConversationSummary): number {
  if (a.kind !== b.kind) return KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
  if (a.kind === "channel") {
    const sa = a.scope ? SCOPE_ORDER[a.scope.type] : 9;
    const sb = b.scope ? SCOPE_ORDER[b.scope.type] : 9;
    if (sa !== sb) return sa - sb;
    return a.title.localeCompare(b.title);
  }
  if (a.kind === "desk") return (b.lastMessageAt ?? "").localeCompare(a.lastMessageAt ?? "");
  return a.title.localeCompare(b.title);
}

/** Every thread this member can read, with unread counts. */
export async function inbox(viewer: PortalMember): Promise<ConversationSummary[]> {
  const memberships = await listMemberships(viewer.sub);
  const byConv = new Map(memberships.map((m) => [m.convId, m]));
  let metas: ConvMeta[];
  if (isStaffRole(viewer.role)) {
    const lists = await Promise.all([
      queryGsiConvs(CONVS_ALL_GSI1PK, false, 1000),
      ...desksFor(viewer.role).map((desk) => queryGsiConvs(deskGsi1Pk(desk), true, 300)),
    ]);
    metas = lists.flat();
  } else {
    metas = await batchGetConvs(memberships.filter((m) => !m.marker).map((m) => m.convId));
  }
  return metas
    .filter((meta) => convAccess(viewer, meta, byConv.get(meta.id)).read)
    .map((meta) => summarize(meta, viewer, byConv.get(meta.id)))
    .sort(sortInbox);
}
