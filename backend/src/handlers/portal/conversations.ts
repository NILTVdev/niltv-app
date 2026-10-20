/**
 * Portal messaging (portal API):
 *
 *   GET  /v1/inbox                                   every thread the caller can read
 *   POST /v1/desks                                   open a desk thread
 *   POST /v1/groups · PUT /v1/groups/{id}            admins: create and edit groups
 *   GET  /v1/conversations/{id}                      thread detail + members
 *   GET  /v1/conversations/{id}/messages             history (?before=) or delta poll (?after=)
 *   POST /v1/conversations/{id}/messages             send
 *   POST /v1/conversations/{id}/read                 move the read marker
 *   PUT  /v1/conversations/{id}/mute
 *   POST /v1/conversations/{id}/messages/{messageId}/hide   staff
 *
 * Access is decided per request from the membership row (convAccess), so a
 * removed member is locked out on their next call.
 */
import {
  ConversationDetail,
  GroupUpsertRequest,
  HideMessageRequest,
  InboxResponse,
  MessagesResponse,
  MuteRequest,
  OpenDeskRequest,
  PortalAck,
  type PortalPerson,
  ReadRequest,
  SendMessageRequest,
  desksFor,
  isStaffRole,
} from "@niltv/types";
import { type Result, can, denied } from "../../lib/portal/access";
import {
  type ConvAccess,
  type ConvMeta,
  type Membership,
  convAccess,
  createGroup,
  getConv,
  getMembership,
  inbox,
  joinConversation,
  leaveConversation,
  listMessages,
  markRead,
  memberSubs,
  openDeskThread,
  presentMessage,
  sendMessage,
  setHidden,
  setMuted,
  summarize,
  updateGroupInfo,
} from "../../lib/portal/conversations";
import { newPortalId } from "../../lib/portal/ids";
import { formerMember, getMember, getMembers, toPerson } from "../../lib/portal/members";
import { enqueue } from "../../lib/portal/notify";
import { type RouteContext, badRequest, notFound, ok, portalHandler } from "../../lib/portal/router";

type Opened =
  | { refused: Result }
  | { meta: ConvMeta; membership: Membership | undefined; access: ConvAccess };

/** Load the thread and the caller's access to it, or the refusal. */
async function open(ctx: RouteContext): Promise<Opened> {
  const meta = await getConv(ctx.param("id"));
  if (!meta) return { refused: notFound() };
  const membership = await getMembership(ctx.caller.sub, meta.id);
  const access = convAccess(ctx.caller.member, meta, membership);
  if (!access.read) return { refused: notFound() };
  return { meta, membership, access };
}

async function peopleOf(meta: ConvMeta): Promise<PortalPerson[]> {
  if (meta.kind === "channel") return [];
  const subs = await memberSubs(meta.id);
  const found = await getMembers(subs);
  return subs.map((sub) => {
    const m = found.get(sub);
    return m ? toPerson(m) : formerMember(sub);
  });
}

/** Add and remove group members to match `want`. Only active members can be added. */
async function setGroupMembers(meta: ConvMeta, want: readonly string[]): Promise<void> {
  const current = new Set(await memberSubs(meta.id));
  const wanted = new Set(want);
  const active = await getMembers([...wanted].filter((sub) => !current.has(sub)));
  for (const sub of current) if (!wanted.has(sub)) await leaveConversation(sub, meta.id);
  for (const member of active.values()) if (member.status === "active") await joinConversation(member.sub, meta);
}

export const handler = portalHandler({
  "GET /v1/inbox": async ({ caller }) => ok(InboxResponse.parse({ conversations: await inbox(caller.member) })),

  "POST /v1/desks": async ({ caller, body }) => {
    const req = body(OpenDeskRequest);
    if (!req) return badRequest();
    const me = caller.member;
    if (!desksFor(me.role).includes(req.desk)) return denied();
    let person = me;
    if (isStaffRole(me.role)) {
      // Staff start a thread with an athlete or guest, on a desk that person may use.
      if (!req.personSub) return badRequest("personSub is required");
      const target = await getMember(req.personSub);
      if (!target || target.status !== "active" || isStaffRole(target.role)) return notFound();
      if (!desksFor(target.role).includes(req.desk)) return denied();
      person = target;
    }
    const meta = await openDeskThread(req.desk, person);
    return ok(summarize(meta, me, await getMembership(caller.sub, meta.id)));
  },

  "POST /v1/groups": async ({ caller, body }) => {
    if (!can(caller, "manageGroups")) return denied();
    const req = body(GroupUpsertRequest);
    if (!req) return badRequest();
    const meta = await createGroup({ id: newPortalId("grp"), title: req.title, about: req.about, createdBySub: caller.sub });
    await setGroupMembers(meta, req.memberSubs);
    const fresh = (await getConv(meta.id)) ?? meta;
    return ok(ConversationDetail.parse({ ...summarize(fresh, caller.member, undefined), members: await peopleOf(fresh) }), 201);
  },

  "PUT /v1/groups/{id}": async ({ caller, body, param }) => {
    if (!can(caller, "manageGroups")) return denied();
    const req = body(GroupUpsertRequest);
    if (!req) return badRequest();
    const meta = await getConv(param("id"));
    if (!meta || meta.kind !== "group") return notFound();
    await updateGroupInfo(meta, req.title, req.about);
    await setGroupMembers(meta, req.memberSubs);
    const fresh = (await getConv(meta.id)) ?? meta;
    return ok(ConversationDetail.parse({ ...summarize(fresh, caller.member, undefined), members: await peopleOf(fresh) }));
  },

  "GET /v1/conversations/{id}": async (ctx) => {
    const thread = await open(ctx);
    if ("refused" in thread) return thread.refused;
    const { meta, membership } = thread;
    return ok(
      ConversationDetail.parse({ ...summarize(meta, ctx.caller.member, membership), members: await peopleOf(meta) }),
    );
  },

  "GET /v1/conversations/{id}/messages": async (ctx) => {
    const thread = await open(ctx);
    if ("refused" in thread) return thread.refused;
    const limit = Number(ctx.query("limit") ?? "50");
    const page = await listMessages(thread.meta.id, {
      before: ctx.query("before"),
      after: ctx.query("after"),
      limit: Number.isFinite(limit) ? limit : 50,
    });
    return ok(
      MessagesResponse.parse({
        messages: page.messages.map((m) => presentMessage(m, ctx.caller.member, thread.meta)),
        ...(page.before ? { before: page.before } : {}),
      }),
    );
  },

  "POST /v1/conversations/{id}/messages": async (ctx) => {
    const thread = await open(ctx);
    if ("refused" in thread) return thread.refused;
    if (!thread.access.post) return denied("STAFF_ONLY", "Only staff post here.");
    const req = ctx.body(SendMessageRequest);
    if (!req) return badRequest();
    const sent = await sendMessage(ctx.caller.member, thread.meta.id, req);
    if (sent.duplicate || !sent.message) return ok(PortalAck.parse({ status: "ok", duplicate: true }));
    await enqueue({ type: "message", convId: thread.meta.id, messageId: sent.message.id, seq: sent.message.seq });
    return ok(presentMessage(sent.message, ctx.caller.member, thread.meta), 201);
  },

  "POST /v1/conversations/{id}/read": async (ctx) => {
    const thread = await open(ctx);
    if ("refused" in thread) return thread.refused;
    const req = ctx.body(ReadRequest);
    if (!req) return badRequest();
    await markRead(ctx.caller.member, thread.meta, Math.min(req.seq, thread.meta.seq));
    return ok(PortalAck.parse({ status: "ok" }));
  },

  "PUT /v1/conversations/{id}/mute": async (ctx) => {
    const thread = await open(ctx);
    if ("refused" in thread) return thread.refused;
    const req = ctx.body(MuteRequest);
    if (!req) return badRequest();
    await setMuted(ctx.caller.member, thread.meta, req.muted);
    return ok(PortalAck.parse({ status: "ok" }));
  },

  "POST /v1/conversations/{id}/messages/{messageId}/hide": async (ctx) => {
    if (!can(ctx.caller, "moderate")) return denied();
    const thread = await open(ctx);
    if ("refused" in thread) return thread.refused;
    const req = ctx.body(HideMessageRequest);
    if (!req) return badRequest();
    if (!(await setHidden(thread.meta.id, ctx.param("messageId"), req.hidden, ctx.caller.sub))) return notFound();
    return ok(PortalAck.parse({ status: "ok" }));
  },
});
