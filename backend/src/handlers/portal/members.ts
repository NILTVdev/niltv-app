/**
 * Portal members and settings (portal API):
 *
 *   GET   /v1/members          roster: athletes, guests, staff (staff + admin)
 *   POST  /v1/members          give an existing niltv.com account access
 *                              (guests: staff + admin; any other role: admin)
 *   PATCH /v1/members/{sub}    edit a member (see canEdit for who may change what)
 *   GET   /v1/athletes/pending accepted athletes with no account yet (staff + admin)
 *   POST  /v1/athletes/pending/{id}/invite   send the invite now (admin; once a day each)
 *   POST  /v1/athletes/pending/{id}/link     connect them to an account on another email (admin)
 *   GET   /v1/settings         admin settings
 *   PUT   /v1/settings
 *
 * Channel memberships follow every change to role, status, campus or sport.
 */
import {
  ApiError,
  MemberAddRequest,
  MemberListResponse,
  MemberUpdateRequest,
  PendingAthletesResponse,
  PendingLinkRequest,
  type PortalMember,
  PortalMember as PortalMemberSchema,
  PortalSettings,
  firstSafeName,
  isStaffRole,
} from "@niltv/types";
import { json } from "../../lib/http";
import { type Caller, can, conflictResult, denied } from "../../lib/portal/access";
import { deleteUnfinished, findAccountByEmail, lookupEmail, nameFromEmail } from "../../lib/portal/accounts";
import { leaveAllGroups, syncChannelMemberships } from "../../lib/portal/conversations";
import { createMember, getMember, getSettings, listMembers, putMember, putSettings } from "../../lib/portal/members";
import { portalUrl } from "../../lib/portal/emails";
import { enqueue, enqueueOrThrow } from "../../lib/portal/notify";
import { claimInvite, deletePending, getPending, listPending, releaseInvite } from "../../lib/portal/pending";
import { badRequest, notFound, ok, portalHandler } from "../../lib/portal/router";

type MemberUpdate = ReturnType<typeof MemberUpdateRequest.parse>;

const noAccountResult = () =>
  json(
    404,
    ApiError.parse({
      error: "NO_ACCOUNT",
      message: `No confirmed niltv.com account uses that email. Ask them to create one at ${portalUrl("/create-account")}, then try again.`,
    }),
  );

/**
 * Admins may change anything except their own role and status (no locking
 * yourself out). Staff may edit guests (name, note, status) and athletes'
 * roster fields (name, campus, sport); never roles, and never staff rows.
 */
export function canEdit(caller: Caller, target: PortalMember, update: MemberUpdate): boolean {
  if (caller.member.role === "admin") {
    if (target.sub === caller.sub && (update.role !== undefined || update.status !== undefined)) return false;
    return true;
  }
  if (caller.member.role !== "staff") return false;
  if (update.role !== undefined || update.desks !== undefined) return false;
  if (target.role === "guest") return true;
  if (target.role === "athlete") return update.status === undefined && update.note === undefined;
  return false;
}

/**
 * Guests: staff and admins; any other role: admins. Adding a disabled or
 * waiting account under another role brings it back, so that needs
 * manageAccess too, whatever the requested role.
 */
export function canAdd(caller: Caller, role: PortalMember["role"], existing?: PortalMember): boolean {
  if (!can(caller, role === "guest" ? "manageGuests" : "manageAccess")) return false;
  if (existing && existing.role !== role && !can(caller, "manageAccess")) return false;
  return true;
}

export const handler = portalHandler({
  "GET /v1/members": async ({ caller }) => {
    if (!can(caller, "viewRoster")) return denied();
    return ok(MemberListResponse.parse({ members: await listMembers() }));
  },

  "POST /v1/members": async ({ caller, body, rejectBody }) => {
    const req = body(MemberAddRequest);
    if (!req) return rejectBody(MemberAddRequest);
    if (!canAdd(caller, req.role)) return denied();

    const account = await findAccountByEmail(req.email);
    if (!account) return noAccountResult();
    const existing = await getMember(account.sub);
    if (existing && existing.status === "active") {
      return conflictResult("CONFLICT", `${existing.name} already has portal access as ${existing.role}.`);
    }
    if (!canAdd(caller, req.role, existing)) return denied();

    const now = new Date().toISOString();
    const member: PortalMember = PortalMemberSchema.parse({
      ...(existing ?? {}),
      sub: account.sub,
      email: account.email,
      // req.name passed DisplayName; the fallbacks were typed elsewhere and are checked here.
      name: req.name ?? firstSafeName([existing?.name, account.name, nameFromEmail(account.email)]),
      role: req.role,
      status: "active",
      desks: isStaffRole(req.role) ? (req.desks ?? []) : [],
      ...(req.note ? { note: req.note } : {}),
      ...(req.role === "athlete" && req.campus ? { campus: req.campus } : {}),
      ...(req.role === "athlete" && req.sport ? { sport: req.sport } : {}),
      edited: [...new Set([...(existing?.edited ?? []), ...(req.name ? ["name"] : []), ...(req.campus ? ["campus"] : []), ...(req.sport ? ["sport"] : [])])],
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
    if (existing) await putMember(member);
    else if (!(await createMember(member))) return conflictResult("CONFLICT", "That account was just added. Refresh the list.");

    await syncChannelMemberships(member);
    if ((await getSettings()).welcomeEmail) await enqueue({ type: "welcome", sub: member.sub });
    return ok(member, 201);
  },

  "PATCH /v1/members/{sub}": async ({ caller, param, body, rejectBody }) => {
    const update = body(MemberUpdateRequest);
    if (!update) return rejectBody(MemberUpdateRequest);
    const target = await getMember(param("sub"));
    if (!target) return notFound();
    if (!canEdit(caller, target, update)) return denied();

    const edited = new Set(target.edited);
    // A field counts as hand-edited only when the value really changes, so a
    // form that resends unchanged values does not freeze it against the sync.
    for (const field of ["name", "campus", "sport"] as const) {
      if (update[field] !== undefined && (update[field] ?? undefined) !== target[field]) edited.add(field);
    }
    const next: PortalMember = PortalMemberSchema.parse({
      ...target,
      ...(update.role !== undefined ? { role: update.role } : {}),
      ...(update.status !== undefined ? { status: update.status } : {}),
      ...(update.name !== undefined ? { name: update.name } : {}),
      ...(update.note !== undefined ? { note: update.note } : {}),
      ...(update.desks !== undefined ? { desks: update.desks } : {}),
      ...(update.campus !== undefined ? { campus: update.campus ?? undefined } : {}),
      ...(update.sport !== undefined ? { sport: update.sport ?? undefined } : {}),
      edited: [...edited],
      updatedAt: new Date().toISOString(),
    });
    if (!isStaffRole(next.role)) next.desks = [];
    await putMember(next);

    await syncChannelMemberships(next);
    if (next.status === "disabled" && target.status !== "disabled") await leaveAllGroups(next.sub);
    const enabled = target.status !== "active" && next.status === "active";
    if (enabled && (await getSettings()).welcomeEmail) await enqueue({ type: "welcome", sub: next.sub });
    return ok(next);
  },

  "GET /v1/athletes/pending": async ({ caller }) => {
    if (!can(caller, "viewRoster")) return denied();
    return ok(PendingAthletesResponse.parse({ pending: await listPending() }));
  },

  "POST /v1/athletes/pending/{id}/invite": async ({ caller, param }) => {
    if (!can(caller, "manageAccess")) return denied();
    const id = Number(param("id"));
    if (!Number.isInteger(id)) return notFound();
    const row = await getPending(id);
    if (!row) return notFound();
    const at = new Date();
    const next = await claimInvite(id, at);
    if (!next) return conflictResult("CONFLICT", `An invite already went to ${row.email} in the last 24 hours.`);
    try {
      // Starting over: a sign-up left unfinished on this address would block them.
      await deleteUnfinished((await lookupEmail(row.email)).unfinished);
      await enqueueOrThrow({ type: "invite", applicationId: id });
    } catch (err) {
      console.error("portal: invite not queued", id, err);
      await releaseInvite(id, at);
      return json(503, ApiError.parse({ error: "TRY_AGAIN", message: "The invite did not go out. Try again in a minute." }));
    }
    return ok(next);
  },

  /**
   * The safe stand-in for matching on a second email: a person looks at it.
   * The account still has to be confirmed and verified. Roster fields follow on
   * the next sync, which now finds the member by application id.
   */
  "POST /v1/athletes/pending/{id}/link": async ({ caller, param, body }) => {
    if (!can(caller, "manageAccess")) return denied();
    const req = body(PendingLinkRequest);
    if (!req) return badRequest();
    const id = Number(param("id"));
    if (!Number.isInteger(id)) return notFound();
    const row = await getPending(id);
    if (!row) return notFound();
    const account = await findAccountByEmail(req.email);
    if (!account) return noAccountResult();

    const existing = await getMember(account.sub);
    if (existing && existing.role !== "athlete") {
      return conflictResult("CONFLICT", `That account is ${existing.role} in the portal, not an athlete.`);
    }
    if (existing?.applicationId !== undefined && existing.applicationId !== id) {
      return conflictResult("CONFLICT", `${existing.name} is already linked to another application.`);
    }
    const now = new Date().toISOString();
    const member: PortalMember = PortalMemberSchema.parse({
      ...(existing ?? {
        sub: account.sub,
        email: account.email,
        name: firstSafeName([row.name, nameFromEmail(account.email)]),
        ...(row.campus ? { campus: row.campus } : {}),
        ...(row.school ? { school: row.school } : {}),
        ...(row.sport ? { sport: row.sport } : {}),
        role: "athlete",
        status: "ready",
        desks: [],
        edited: [],
        createdAt: now,
      }),
      applicationId: id,
      updatedAt: now,
    });
    if (existing) await putMember(member);
    else if (!(await createMember(member))) return conflictResult("CONFLICT", "That account was just added. Refresh the list.");
    await deletePending(id);
    return ok(member);
  },

  "GET /v1/settings": async ({ caller }) => {
    if (!can(caller, "manageAccess")) return denied();
    return ok(await getSettings());
  },

  "PUT /v1/settings": async ({ caller, body }) => {
    if (!can(caller, "manageAccess")) return denied();
    const settings = body(PortalSettings);
    if (!settings) return badRequest();
    await putSettings(settings);
    return ok(settings);
  },
});
