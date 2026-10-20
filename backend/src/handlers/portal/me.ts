/**
 * GET /v1/me · PATCH /v1/me (portal API) — the caller's own portal account:
 * role, roster fields, notification settings, and the unread total for the
 * Messages badge.
 */
import { PortalMeResponse, PortalMeUpdate, desksFor, isStaffRole } from "@niltv/types";
import { inbox } from "../../lib/portal/conversations";
import { putMember } from "../../lib/portal/members";
import { badRequest, ok, portalHandler } from "../../lib/portal/router";

const SEEN_EVERY_MS = 10 * 60 * 1000;

export const handler = portalHandler({
  "GET /v1/me": async ({ caller }) => {
    const threads = await inbox(caller.member);
    const unreadMessages = threads.filter((t) => !t.muted).reduce((sum, t) => sum + t.unread, 0);
    let member = caller.member;
    const now = Date.now();
    if (!member.lastSeenAt || now - Date.parse(member.lastSeenAt) > SEEN_EVERY_MS) {
      member = { ...member, lastSeenAt: new Date(now).toISOString() };
      await putMember(member);
    }
    return ok(PortalMeResponse.parse({ member, unreadMessages }));
  },

  "PATCH /v1/me": async ({ caller, body }) => {
    const update = body(PortalMeUpdate);
    if (!update) return badRequest();
    const current = caller.member;
    const allowedDesks = new Set(desksFor(current.role));
    const member = {
      ...current,
      ...(update.name !== undefined && update.name !== current.name
        ? { name: update.name, edited: [...new Set([...current.edited, "name"])] }
        : {}),
      ...(update.timezone !== undefined ? { timezone: update.timezone } : {}),
      ...(update.notify ? { notify: { ...current.notify, ...update.notify } } : {}),
      ...(update.desks !== undefined && isStaffRole(current.role)
        ? { desks: [...new Set(update.desks.filter((d) => allowedDesks.has(d)))] }
        : {}),
      updatedAt: new Date().toISOString(),
    };
    await putMember(member);
    const threads = await inbox(member);
    const unreadMessages = threads.filter((t) => !t.muted).reduce((sum, t) => sum + t.unread, 0);
    return ok(PortalMeResponse.parse({ member, unreadMessages }));
  },
});
