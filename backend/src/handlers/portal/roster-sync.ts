/**
 * portal-roster-sync (scheduled): accepted athletes from dashboard
 * onboarding become portal athletes.
 *
 * "Accepted" in onboarding means the agreement is signed and Stripe is
 * complete (international athletes skip Stripe). Each one is matched to
 * their niltv.com account by email, the same account they applied with.
 *
 * New athletes land as `ready` while Settings.autoEnableAthletes is off
 * (the testing period): an admin enables them in the portal. With it on
 * they are `active` at once and join their channels. Roster fields
 * (campus, sport, school, year, handle) follow the application unless
 * staff edited that field by hand.
 */
import { CAMPUS_CHANNELS, type PortalMember, PortalMember as PortalMemberSchema } from "@niltv/types";
import { dashboardApiKey } from "../../lib/roster";
import { findAccountByEmail, nameFromEmail } from "../../lib/portal/accounts";
import { syncChannelMemberships } from "../../lib/portal/conversations";
import { createMember, getMember, getSettings, listMembers, putMember } from "../../lib/portal/members";
import { enqueue } from "../../lib/portal/notify";
import { findProfileIdByHandle } from "../../lib/portal/profiles";

/** The fields this job reads from GET /api/applications/ (dashboard ApplicationOut). */
export interface AcceptedApplication {
  id: number;
  email: string;
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
  noAccount: number;
  dryRun: boolean;
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
  const result: SyncResult = { accepted: apps.length, created: 0, updated: 0, noAccount: 0, dryRun };

  for (const app of apps) {
    const fields = rosterFields(app);
    let existing = byApp.get(app.id) ?? byEmail.get(app.email.toLowerCase());
    let account: Awaited<ReturnType<typeof findAccountByEmail>>;
    if (!existing) {
      account = await findAccountByEmail(app.email);
      if (!account) {
        result.noAccount++;
        continue;
      }
      existing = await getMember(account.sub);
    }

    if (existing) {
      // Staff and guests who also applied keep their role; only the link is recorded.
      if (existing.role !== "athlete") {
        if (existing.applicationId !== app.id) {
          if (!dryRun) await putMember({ ...existing, applicationId: app.id, updatedAt: now });
          result.updated++;
        }
        continue;
      }
      let next = mergeRoster(existing, fields);
      if (!next.profileId && next.instagram) {
        const profileId = await findProfileIdByHandle(next.instagram);
        if (profileId) next = { ...next, profileId };
      }
      if (!same(existing, next)) {
        if (!dryRun) {
          await putMember({ ...next, updatedAt: now });
          if (next.status === "active" && (existing.campus !== next.campus || existing.sport !== next.sport)) {
            await syncChannelMemberships(next);
          }
        }
        result.updated++;
      }
      continue;
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
      continue;
    }
    if (!(await createMember(member))) continue;
    result.created++;
    if (member.status === "active") {
      await syncChannelMemberships(member);
      if (settings.welcomeEmail) await enqueue({ type: "welcome", sub: member.sub });
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
