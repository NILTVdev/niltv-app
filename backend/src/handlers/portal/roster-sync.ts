/**
 * portal-roster-sync (scheduled): accepted athletes from dashboard
 * onboarding become portal athletes.
 *
 * "Accepted" in onboarding means the agreement is signed and Stripe is
 * complete (international athletes skip Stripe). Each one is matched to a
 * confirmed niltv.com account by email: the application's main address, then
 * its college address.
 *
 * Athletes with no account go on the pending list, which staff see on
 * Athletes. Once Settings.welcomeEmail is on, each gets one invite to create
 * an account, and a later run picks them up.
 *
 * New athletes land as `ready` while Settings.autoEnableAthletes is off
 * (the testing period): an admin enables them in the portal. With it on
 * they are `active` at once and join their channels, and anyone already
 * waiting is released on the next run. Roster fields (campus, sport,
 * school, year, handle) follow the application unless staff edited that
 * field by hand.
 */
import { CAMPUS_CHANNELS, type PortalMember, PortalMember as PortalMemberSchema } from "@niltv/types";
import { dashboardApiKey } from "../../lib/roster";
import { findAccountByEmail, nameFromEmail } from "../../lib/portal/accounts";
import { syncChannelMemberships } from "../../lib/portal/conversations";
import { createMember, getMember, getSettings, listMembers, putMember } from "../../lib/portal/members";
import { enqueue } from "../../lib/portal/notify";
import { claimInvite, deletePending, listPending, savePending } from "../../lib/portal/pending";
import { findProfileIdByHandle } from "../../lib/portal/profiles";

/** The fields this job reads from GET /api/applications/ (dashboard ApplicationOut). */
export interface AcceptedApplication {
  id: number;
  email: string;
  college_email?: string | null;
  first_name: string | null;
  last_name: string | null;
  university: string | null;
  sport: string | null;
  year: string | null;
  campus_channel: string | null;
  instagram: string | null;
  international: boolean | null;
  status: string;
}

type RosterFields = Pick<PortalMember, "name" | "campus" | "school" | "sport" | "year" | "instagram" | "applicationId" | "stripe">;

export function rosterFields(app: AcceptedApplication): RosterFields {
  const name = [app.first_name, app.last_name].map((s) => (s ?? "").trim()).filter(Boolean).join(" ");
  const campus = app.campus_channel && CAMPUS_CHANNELS[app.campus_channel] ? app.campus_channel : undefined;
  return {
    name: name || nameFromEmail(app.email),
    ...(campus ? { campus } : {}),
    ...(app.university ? { school: app.university } : {}),
    ...(app.sport ? { sport: app.sport } : {}),
    ...(app.year ? { year: app.year } : {}),
    ...(app.instagram ? { instagram: app.instagram.replace(/^@/, "").toLowerCase() } : {}),
    applicationId: app.id,
    stripe: app.international ? "international" : "complete",
  };
}

/** Apply roster fields to a member, skipping any field staff set by hand. */
export function mergeRoster(member: PortalMember, fields: RosterFields): PortalMember {
  const next: PortalMember = { ...member };
  for (const [key, value] of Object.entries(fields) as [keyof RosterFields, unknown][]) {
    if (member.edited.includes(key)) continue;
    (next as Record<string, unknown>)[key] = value;
  }
  return next;
}

const same = (a: PortalMember, b: PortalMember): boolean =>
  (["name", "campus", "school", "sport", "year", "instagram", "applicationId", "stripe", "profileId"] as const).every(
    (k) => a[k] === b[k],
  );

async function fetchAccepted(baseUrl: string, apiKey: string): Promise<AcceptedApplication[]> {
  const res = await fetch(`${baseUrl}/api/applications/?status=accepted&limit=2000`, {
    headers: { "X-API-Key": apiKey },
  });
  if (!res.ok) throw new Error(`dashboard applications: HTTP ${res.status}`);
  const rows = (await res.json()) as AcceptedApplication[];
  return rows.filter((r) => r.status === "accepted" && typeof r.email === "string" && r.email.includes("@"));
}

export interface SyncResult {
  accepted: number;
  created: number;
  updated: number;
  /** waiting athletes released because auto-enable is on */
  enabled: number;
  noAccount: number;
  /** invites sent this run */
  invited: number;
  /** applications that threw; the rest of the run still finishes */
  failed: number;
  dryRun: boolean;
}

/** The account for an application: its main email first, then its college email. */
async function accountFor(app: AcceptedApplication): Promise<Awaited<ReturnType<typeof findAccountByEmail>>> {
  const main = await findAccountByEmail(app.email);
  if (main || !app.college_email) return main;
  return findAccountByEmail(app.college_email);
}

/** `dryRun` counts what would change and writes nothing (the pre-launch check). */
export async function syncRoster(
  apps: readonly AcceptedApplication[],
  opts: { now?: string; dryRun?: boolean } = {},
): Promise<SyncResult> {
  const now = opts.now ?? new Date().toISOString();
  const dryRun = opts.dryRun === true;
  const settings = await getSettings();
  const members = await listMembers();
  const byApp = new Map(members.filter((m) => m.applicationId !== undefined).map((m) => [m.applicationId!, m]));
  const byEmail = new Map(members.map((m) => [m.email.toLowerCase(), m]));
  const pending = new Map((await listPending()).map((p) => [p.applicationId, p]));
  const result: SyncResult = {
    accepted: apps.length,
    created: 0,
    updated: 0,
    enabled: 0,
    noAccount: 0,
    invited: 0,
    failed: 0,
    dryRun,
  };
  /** applications that stay on the pending list after this run */
  const stillPending = new Set<number>();

  const noAccount = async (app: AcceptedApplication, fields: RosterFields): Promise<void> => {
    result.noAccount++;
    stillPending.add(app.id);
    const row = {
      applicationId: app.id,
      email: app.email.trim().toLowerCase(),
      name: fields.name,
      ...(fields.campus ? { campus: fields.campus } : {}),
      ...(fields.school ? { school: fields.school } : {}),
      ...(fields.sport ? { sport: fields.sport } : {}),
      firstSeenAt: now,
    };
    const known = pending.get(app.id);
    const changed =
      !known || (["email", "name", "campus", "school", "sport"] as const).some((k) => known[k] !== row[k]);
    if (dryRun) {
      if (settings.welcomeEmail && !known?.invitedAt) result.invited++;
      return;
    }
    if (changed) await savePending(row);
    if (settings.welcomeEmail && !known?.invitedAt && (await claimInvite(app.id, new Date(now)))) {
      await enqueue({ type: "invite", applicationId: app.id });
      result.invited++;
    }
  };

  const syncOne = async (app: AcceptedApplication): Promise<void> => {
    const fields = rosterFields(app);
    const college = app.college_email?.toLowerCase();
    let existing = byApp.get(app.id) ?? byEmail.get(app.email.toLowerCase()) ?? (college ? byEmail.get(college) : undefined);
    let account: Awaited<ReturnType<typeof findAccountByEmail>>;
    if (!existing) {
      account = await accountFor(app);
      if (!account) return noAccount(app, fields);
      existing = await getMember(account.sub);
    }

    if (existing) {
      // Staff and guests who also applied keep their role; only the link is recorded.
      if (existing.role !== "athlete") {
        if (existing.applicationId !== app.id) {
          if (!dryRun) await putMember({ ...existing, applicationId: app.id, updatedAt: now });
          result.updated++;
        }
        return;
      }
      let next = mergeRoster(existing, fields);
      if (!next.profileId && next.instagram) {
        const profileId = await findProfileIdByHandle(next.instagram);
        if (profileId) next = { ...next, profileId };
      }
      // Only `ready` moves on its own. A disabled athlete stays disabled.
      const release = settings.autoEnableAthletes && existing.status === "ready";
      if (release) next = { ...next, status: "active" };
      if (release || !same(existing, next)) {
        if (!dryRun) {
          await putMember({ ...next, updatedAt: now });
          if (release || (next.status === "active" && (existing.campus !== next.campus || existing.sport !== next.sport))) {
            await syncChannelMemberships(next);
          }
          if (release && settings.welcomeEmail) await enqueue({ type: "welcome", sub: next.sub });
        }
        if (release) result.enabled++;
        else result.updated++;
      }
      return;
    }

    const profileId = fields.instagram ? await findProfileIdByHandle(fields.instagram) : undefined;
    const member = PortalMemberSchema.parse({
      sub: account!.sub,
      email: account!.email,
      ...fields,
      ...(profileId ? { profileId } : {}),
      role: "athlete",
      status: settings.autoEnableAthletes ? "active" : "ready",
      desks: [],
      edited: [],
      createdAt: now,
    });
    if (dryRun) {
      result.created++;
      return;
    }
    if (!(await createMember(member))) return;
    result.created++;
    if (member.status === "active") {
      await syncChannelMemberships(member);
      if (settings.welcomeEmail) await enqueue({ type: "welcome", sub: member.sub });
    }
  };

  for (const app of apps) {
    try {
      await syncOne(app);
    } catch (err) {
      // One bad row must not stop everyone behind it. Keep its pending row too.
      result.failed++;
      stillPending.add(app.id);
      console.error("portal-roster-sync: application failed", app.id, err);
    }
  }

  // Everyone else on the list now has an account, or is no longer accepted.
  // An empty roster is more likely a bad response than a real answer.
  if (!dryRun && apps.length > 0) {
    for (const id of pending.keys()) {
      if (!stillPending.has(id)) await deletePending(id);
    }
  }
  return result;
}

/** Scheduled with no payload; invoke with {"dryRun": true} to count without writing. */
export const handler = async (event?: { dryRun?: boolean }): Promise<SyncResult> => {
  const baseUrl = process.env.DASHBOARD_API_URL;
  const keyParam = process.env.DASHBOARD_API_KEY_PARAM;
  if (!baseUrl || !keyParam) throw new Error("DASHBOARD_API_URL / DASHBOARD_API_KEY_PARAM unset");
  const apps = await fetchAccepted(baseUrl, await dashboardApiKey(keyParam));
  const result = await syncRoster(apps, { dryRun: event?.dryRun === true });
  console.log("portal-roster-sync", JSON.stringify(result));
  return result;
};
