/**
 * Roster sync (content foundation): the dashboard's ambassadors table is the
 * owner of who our athletes are; the app keeps a synced copy as Profile rows
 * so enrichment can credit people by handle and every surface can read
 * school, sport and campus off the same row.
 *
 * Identity across handle renames is the dashboard id (`rosterId`); a profile
 * is matched by that first, then by current or previous handle. Imported
 * profiles carry `statuses: ["athlete"]` only — the ambassador flag (which
 * puts a person on the app's Featured rail) stays a staff decision.
 */
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { Profile } from "@niltv/types";
import { GSI1, PROFILES_ALL_GSI1PK, getDocClient, profileKey } from "./db";
import type { Item } from "./shape";

/**
 * One person from either dashboard roster, normalized. Ambassadors come from
 * GET /api/ambassadors/ (the network programme); Duke athletes come from
 * GET /api/athletes/ (the TrueBlueTV roster, school implied). Both carry an
 * Instagram handle, which is the join to content.
 */
export interface DashboardAmbassador {
  /** "amb-{id}" or "duke-{id}" — the stable identity across handle renames */
  id: number | string;
  ig_username: string | null;
  display_name: string | null;
  previous_usernames: string | null;
  campus: string | null;
  school: string | null;
  sport: string | null;
  year: string | null;
  cohort: string | null;
  status: string;
  active: boolean;
  ig_user_id?: string | null;
}

/** GET /api/athletes/ (dashboard, AthleteOut) — the Duke roster. */
export interface DashboardAthlete {
  id: number;
  name: string;
  sport: string | null;
  year: string | null;
  ig_handle: string | null;
  active: boolean;
}

/** The school every row of the dashboard's athletes table belongs to. */
export const ATHLETES_TABLE_SCHOOL = "Duke";

export const athleteAsRosterRow = (a: DashboardAthlete): DashboardAmbassador => ({
  id: `duke-${a.id}`,
  ig_username: a.ig_handle,
  display_name: a.name,
  previous_usernames: null,
  campus: "truebluetv",
  school: ATHLETES_TABLE_SCHOOL,
  sport: a.sport,
  year: a.year && a.year !== "NaN" ? a.year : null,
  cohort: null,
  status: "confirmed",
  active: a.active,
});

export const ambassadorAsRosterRow = (a: Omit<DashboardAmbassador, "id"> & { id: number }): DashboardAmbassador => ({
  ...a,
  id: `amb-${a.id}`,
});

/** URL/key-safe slug — same rules as the admin id helpers. */
export const slugify = (input: string): string =>
  input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "athlete";

/** Instagram display names carry taglines ("Seven | Growing Through Discipline"); keep the name. */
export function displayNameOf(a: Pick<DashboardAmbassador, "display_name" | "ig_username">): string {
  const raw = (a.display_name ?? "").split(/\s*[|•·]\s*/)[0]?.trim() ?? "";
  if (raw.length > 0) return raw;
  return a.ig_username ?? "Athlete";
}

export const previousHandlesOf = (a: Pick<DashboardAmbassador, "previous_usernames">): string[] =>
  (a.previous_usernames ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase().replace(/^@/, ""))
    .filter((h) => h.length > 0 && h !== "none");

/**
 * The Profile row for an ambassador, merged over the existing row when one
 * matched. Staff-owned fields (bio, statuses, rank, avatar, socials, brands,
 * claimedBy) are never overwritten by the sync.
 */
export function profileFromAmbassador(a: DashboardAmbassador, existing: Item | undefined, now: string): Item | undefined {
  const handle = (a.ig_username ?? "").toLowerCase().replace(/^@/, "");
  if (!handle) return undefined;
  const id = typeof existing?.["id"] === "string" ? existing["id"] : `ath-${slugify(handle)}`;
  const entity = Profile.parse({
    ...(existing ?? {}),
    id,
    name: typeof existing?.["name"] === "string" && existing["name"] && existing["nameOverride"] === true ? existing["name"] : displayNameOf(a),
    handle,
    school: a.school ?? (typeof existing?.["school"] === "string" ? existing["school"] : ""),
    sport: a.sport ?? (typeof existing?.["sport"] === "string" ? existing["sport"] : ""),
    statuses: Array.isArray(existing?.["statuses"]) ? existing["statuses"] : ["athlete"],
    ...(a.campus ? { campus: a.campus } : {}),
    ...(a.year ? { year: a.year } : {}),
    ...(a.cohort ? { cohort: a.cohort } : {}),
    ...(a.ig_user_id ? { igUserId: a.ig_user_id } : {}),
    rosterId: typeof existing?.["rosterId"] === "string" ? existing["rosterId"] : String(a.id),
    rosterStatus: a.status,
    previousHandles: previousHandlesOf(a),
    syncedAt: now,
  });
  const refs = new Set<string>(Array.isArray(existing?.["rosterRefs"]) ? (existing["rosterRefs"] as string[]) : []);
  refs.add(String(a.id));
  return {
    ...(existing ?? {}),
    ...entity,
    ...profileKey(entity.id),
    // every dashboard row this person appears as (an ambassador who is also on the Duke roster has two)
    rosterRefs: [...refs],
    GSI1PK: PROFILES_ALL_GSI1PK,
    GSI1SK: typeof existing?.["GSI1SK"] === "string" ? existing["GSI1SK"] : entity.name,
  };
}

/** Every profile in the directory partition (real athletes and channel pseudo-profiles alike). */
export async function allProfiles(table: string): Promise<Item[]> {
  const rows: Item[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const out = await getDocClient().send(
      new QueryCommand({
        TableName: table,
        IndexName: GSI1,
        KeyConditionExpression: "GSI1PK = :pk",
        ExpressionAttributeValues: { ":pk": PROFILES_ALL_GSI1PK },
        ExclusiveStartKey: startKey,
      }),
    );
    rows.push(...((out.Items ?? []) as Item[]));
    startKey = out.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (startKey);
  return rows;
}

export interface RosterImportResult {
  created: number;
  updated: number;
  skipped: number;
}

/** Upsert one Profile per ambassador. Match by rosterId, then by any handle they have carried. */
export async function importRoster(table: string, ambassadors: readonly DashboardAmbassador[]): Promise<RosterImportResult> {
  const existing = await allProfiles(table);
  const byRosterId = new Map<string, Item>();
  const byHandle = new Map<string, Item>();
  for (const p of existing) {
    if (typeof p["rosterId"] === "string") byRosterId.set(p["rosterId"], p);
    if (Array.isArray(p["rosterRefs"])) for (const ref of p["rosterRefs"] as string[]) byRosterId.set(ref, p);
    if (typeof p["handle"] === "string") byHandle.set(p["handle"].toLowerCase(), p);
    if (Array.isArray(p["previousHandles"])) for (const h of p["previousHandles"] as string[]) byHandle.set(h.toLowerCase(), p);
  }
  const now = new Date().toISOString();
  const result: RosterImportResult = { created: 0, updated: 0, skipped: 0 };
  for (const a of ambassadors) {
    if (!a.active || a.status === "removed" || !a.ig_username) {
      result.skipped += 1;
      continue;
    }
    const match =
      byRosterId.get(String(a.id)) ??
      byHandle.get(a.ig_username.toLowerCase()) ??
      previousHandlesOf(a).map((h) => byHandle.get(h)).find((p) => p !== undefined);
    const row = profileFromAmbassador(a, match, now);
    if (!row) {
      result.skipped += 1;
      continue;
    }
    await getDocClient().send(new PutCommand({ TableName: table, Item: row }));
    // A later row in the same run (the Duke roster after the ambassadors)
    // must find the profile this row just created or updated.
    byRosterId.set(String(a.id), row);
    byHandle.set(a.ig_username.toLowerCase(), row);
    for (const h of previousHandlesOf(a)) byHandle.set(h, row);
    if (match) result.updated += 1;
    else result.created += 1;
  }
  return result;
}

/** The dashboard API key from SSM (same parameter the ingest bridge uses). */
export async function dashboardApiKey(paramName: string): Promise<string> {
  const out = await new SSMClient({}).send(new GetParameterCommand({ Name: paramName, WithDecryption: true }));
  const value = out.Parameter?.Value;
  if (!value) throw new Error(`SSM parameter ${paramName} is empty`);
  return value;
}

export async function fetchAmbassadors(baseUrl: string, apiKey: string): Promise<DashboardAmbassador[]> {
  const res = await fetch(`${baseUrl}/api/ambassadors/?status=active`, { headers: { "X-API-Key": apiKey } });
  if (!res.ok) throw new Error(`dashboard ambassadors ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return ((await res.json()) as Array<Omit<DashboardAmbassador, "id"> & { id: number }>).map(ambassadorAsRosterRow);
}

export async function fetchDukeAthletes(baseUrl: string, apiKey: string): Promise<DashboardAmbassador[]> {
  const res = await fetch(`${baseUrl}/api/athletes/`, { headers: { "X-API-Key": apiKey } });
  if (!res.ok) throw new Error(`dashboard athletes ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return ((await res.json()) as DashboardAthlete[]).map(athleteAsRosterRow);
}

/** Both rosters, ambassadors first so the network programme's row owns the profile when a person is in both. */
export async function fetchRoster(baseUrl: string, apiKey: string): Promise<DashboardAmbassador[]> {
  const [ambassadors, athletes] = await Promise.all([fetchAmbassadors(baseUrl, apiKey), fetchDukeAthletes(baseUrl, apiKey)]);
  return [...ambassadors, ...athletes];
}
