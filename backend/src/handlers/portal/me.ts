/**
 * The caller's own portal account (portal API):
 *
 *   GET   /v1/me             role, roster fields, notification settings, the
 *                            unread total for the Messages badge, and what
 *                            reaches members outside the portal right now
 *   PATCH /v1/me
 *   GET   /v1/push           this account's push devices
 *   POST  /v1/push           subscribe this browser (only while push is on)
 *   POST  /v1/push/remove    unsubscribe this browser, or remove a listed device
 *
 * "Last seen" is recorded for every request in authorize (lib/portal/access.ts).
 */
import {
  PortalAck,
  PortalMeResponse,
  PortalMeUpdate,
  type PortalMember,
  type PortalNotifications,
  PushDevicesResponse,
  PushRemoveRequest,
  PushSubscribeRequest,
  desksFor,
  isStaffRole,
} from "@niltv/types";
import { conflictResult } from "../../lib/portal/access";
import { inbox } from "../../lib/portal/conversations";
import { getSettings, putMember } from "../../lib/portal/members";
import { deviceId, listDevices, publicDevice, removeDevice, saveDevice, vapidPublicKey } from "../../lib/portal/push";
import { badRequest, ok, portalHandler } from "../../lib/portal/router";

async function notifications(): Promise<PortalNotifications> {
  const settings = await getSettings();
  const key = settings.webPush ? await vapidPublicKey() : undefined;
  return { activityEmails: settings.activityEmails, webPush: settings.webPush, ...(key ? { vapidPublicKey: key } : {}) };
}

async function meResponse(member: PortalMember): Promise<PortalMeResponse> {
  const [threads, reach] = await Promise.all([inbox(member), notifications()]);
  const unreadMessages = threads.filter((t) => !t.muted).reduce((sum, t) => sum + t.unread, 0);
  return PortalMeResponse.parse({ member, unreadMessages, notifications: reach });
}

/** "Chrome on Mac" when the browser did not name itself. */
function labelFrom(userAgent: string | undefined): string {
  const ua = userAgent ?? "";
  const device = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : "";
  if (device === "iPhone" || device === "iPad") return device;
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Browser";
  return device ? `${browser} on ${device}` : browser;
}

export const handler = portalHandler({
  "GET /v1/me": async ({ caller }) => ok(await meResponse(caller.member)),

  "PATCH /v1/me": async ({ caller, body, rejectBody }) => {
    const update = body(PortalMeUpdate);
    if (!update) return rejectBody(PortalMeUpdate);
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
    return ok(await meResponse(member));
  },

  "GET /v1/push": async ({ caller }) =>
    ok(PushDevicesResponse.parse({ devices: (await listDevices(caller.sub)).map(publicDevice) })),

  "POST /v1/push": async ({ caller, body, event }) => {
    const req = body(PushSubscribeRequest);
    if (!req) return badRequest();
    const reach = await notifications();
    if (!reach.webPush || !reach.vapidPublicKey) {
      return conflictResult("CONFLICT", "Phone and browser notifications are off for now.");
    }
    const device = await saveDevice(caller.sub, req, req.label ?? labelFrom(event.headers?.["user-agent"]));
    return ok(device, 201);
  },

  "POST /v1/push/remove": async ({ caller, body }) => {
    const req = body(PushRemoveRequest);
    if (!req) return badRequest();
    await removeDevice(caller.sub, req.id ?? deviceId(req.endpoint!));
    return ok(PortalAck.parse({ status: "ok" }));
  },
});
