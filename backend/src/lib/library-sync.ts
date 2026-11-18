/**
 * Library sync: after each ingest run, the bridge sends the dashboard a full
 * snapshot of the content library with its labels (POST /api/library/sync,
 * contract `DashboardLibrarySync` in @niltv/types). The dashboard joins it to
 * its own Instagram view counts by `ig_post_id` for the searchable library.
 *
 * What leaves the app here is the same as what the app and site already show:
 * titles, captions, tags, credited athletes and public CloudFront URLs. Never
 * a bucket URL, never the rights record or licence fields.
 *
 * Mapping is pure and unit-tested; `runLibrarySync` is the one entry point the
 * handler calls, and it never throws: a failed sync is logged and the ingest
 * run carries on.
 */
import { ScanCommand, type ScanCommandInput } from "@aws-sdk/lib-dynamodb";
import {
  DASHBOARD_LIBRARY_SYNC_MAX_ITEMS,
  type DashboardLibraryAthlete,
  type DashboardLibraryItem,
  DashboardLibrarySync,
  DashboardLibrarySyncResponse,
} from "@niltv/types";
import { CHANNEL_PK_PREFIX, getDocClient } from "./db";
import { allProfiles } from "./roster";
import type { Item } from "./shape";

const CONTENT_PK_PREFIX = "CONTENT#";

/** The row attributes the sync reads. Everything else (rights, files, probe, overrides) stays behind. */
export const LIBRARY_SYNC_ATTRIBUTES = [
  "PK",
  "id",
  "name",
  "title",
  "channelId",
  "athleteId",
  "featuredAthleteIds",
  "description",
  "source",
  "summary",
  "keywords",
  "sport",
  "school",
  "contentType",
  "contentTypes",
  "categories",
  "sponsor",
  "unresolvedHandles",
  "transcodeStatus",
  "withdrawnAt",
  "qc",
  "playbackUrl",
  "playbackPath",
  "thumbUrl",
  "thumbPath",
  "duration",
  "publishedAt",
  "sourcePlatform",
  "sourcePostId",
  "sourcePostedAt",
  "syndicationUpdatedAt",
  "updatedAt",
] as const;

/**
 * One page of the library Scan: every live CONTENT row and every CHANNEL row
 * (for channel names) in one pass, projected to the attributes above. Every
 * name is aliased, since several (name, source, duration) are reserved words.
 * Tombstones are filtered out, so a removed clip drops out of the snapshot and
 * the dashboard marks it removed.
 */
export function libraryScanInput(table: string, startKey?: Record<string, unknown>): ScanCommandInput {
  const names: Record<string, string> = { "#removed": "removed" };
  const projection = LIBRARY_SYNC_ATTRIBUTES.map((attr, i) => {
    names[`#a${i}`] = attr;
    return `#a${i}`;
  });
  return {
    TableName: table,
    FilterExpression:
      "(begins_with(#a0, :content) OR begins_with(#a0, :channel)) AND SK = :meta AND attribute_not_exists(#removed)",
    ProjectionExpression: projection.join(", "),
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: { ":content": CONTENT_PK_PREFIX, ":channel": CHANNEL_PK_PREFIX, ":meta": "META" },
    ...(startKey ? { ExclusiveStartKey: startKey } : {}),
  };
}

export interface LibraryRows {
  content: Item[];
  channels: Map<string, Item>;
}

/** Paginated Scan: a Scan filter runs per 1 MB page, so one call would silently miss rows. */
export async function scanLibraryRows(table: string): Promise<LibraryRows> {
  const content: Item[] = [];
  const channels = new Map<string, Item>();
  let startKey: Record<string, unknown> | undefined;
  do {
    const out = await getDocClient().send(new ScanCommand(libraryScanInput(table, startKey)));
    for (const row of (out.Items ?? []) as Item[]) {
      const pk = String(row["PK"] ?? "");
      if (pk.startsWith(CHANNEL_PK_PREFIX)) channels.set(String(row["id"] ?? pk.slice(CHANNEL_PK_PREFIX.length)), row);
      else if (pk.startsWith(CONTENT_PK_PREFIX)) content.push(row);
    }
    startKey = out.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (startKey);
  return { content, channels };
}

/* ── Field helpers ────────────────────────────────────────────────────────── */

const str = (v: unknown): string | null => (typeof v === "string" && v.trim().length > 0 ? v : null);

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((s): s is string => typeof s === "string" && s.trim().length > 0) : [];

const record = (v: unknown): Item => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Item) : {});

/** Any parseable timestamp → canonical ISO UTC, else null. */
export function isoOrNull(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/**
 * True for a URL a viewer can open: https, not an S3 bucket host and not a
 * presigned link. Stored absolute URLs (fixtures, embeds) are checked too.
 */
export function isPublicMediaUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  if (/(^|\.)s3([.-][a-z0-9-]+)*\.amazonaws\.com$/i.test(parsed.hostname)) return false;
  if (/x-amz-/i.test(parsed.search)) return false;
  return true;
}

/**
 * The public URL for a row's media, built the way the read handlers build it
 * (lib/shape resolveMediaUrl): a stored absolute URL wins, else the CloudFront
 * base plus the stored path. Only `/video/*` paths are served publicly, so any
 * other path (masters, originals) gives null.
 */
export function publicMediaUrl(row: Item, urlAttr: string, pathAttr: string, playbackBase: string): string | null {
  const url = str(row[urlAttr]);
  if (url) return isPublicMediaUrl(url) ? url : null;
  const path = str(row[pathAttr]);
  if (!playbackBase || !path || !path.startsWith("/video/")) return null;
  const built = `${playbackBase.replace(/\/+$/, "")}${path}`;
  return isPublicMediaUrl(built) ? built : null;
}

/** The Instagram media id when the clip came from Instagram, else null. */
export function igPostIdFor(row: Item): string | null {
  const source = record(row["source"]);
  const kind = str(source["kind"]) ?? "";
  if (kind.startsWith("instagram")) {
    const id = str(source["postId"]) ?? str(row["sourcePostId"]);
    if (id) return id;
  }
  if (row["sourcePlatform"] === "instagram") {
    const id = str(row["sourcePostId"]) ?? str(source["postId"]);
    if (id) return id;
  }
  return null;
}

/** Lifecycle status as stored: a withdrawn clip reads "withdrawn", else its transcode status. */
export function libraryStatus(row: Item): string {
  if (str(row["withdrawnAt"])) return "withdrawn";
  return str(row["transcodeStatus"]) ?? "unknown";
}

/**
 * One QC state for the library view, from the per-surface verdicts (lib/enrich
 * qcFor). The app verdict comes first (a clip that cannot play is
 * needs-review); then any tagging gap on the site or partner surface; then the
 * site verdict. A partner rights hold is not a library concern and is left out.
 */
export function libraryQcState(row: Item): string | null {
  const qc = record(row["qc"]);
  const app = str(qc["app"]);
  if (!app) return null;
  if (app !== "ready") return app;
  if (qc["site"] === "needs-tagging" || qc["partners"] === "needs-tagging") return "needs-tagging";
  return str(qc["site"]) ?? app;
}

/**
 * Every athlete credited on the clip: the primary credit, then everyone
 * featured, in order and once each. Channel pseudo-profiles (`p-{account}`)
 * are the channel, not a person, and are left out. An id with no profile row
 * keeps its id with a null name and handle.
 */
export function athletesFor(row: Item, profilesById: ReadonlyMap<string, Item>): DashboardLibraryAthlete[] {
  const ids = [str(row["athleteId"]), ...strings(row["featuredAthleteIds"])].filter(
    (id): id is string => id !== null && !id.startsWith("p-"),
  );
  return [...new Set(ids)].map((id) => {
    const profile = profilesById.get(id);
    return {
      id,
      name: str(profile?.["name"]),
      handle: str(profile?.["handle"]),
    };
  });
}

/** The latest of the timestamps a row carries for its last change. */
export function updatedAtFor(row: Item): string | null {
  const candidates = [row["updatedAt"], row["syndicationUpdatedAt"], record(row["qc"])["at"], row["publishedAt"]]
    .map(isoOrNull)
    .filter((v): v is string => v !== null)
    .sort();
  return candidates.length > 0 ? candidates[candidates.length - 1]! : null;
}

export interface LibraryContext {
  channels: ReadonlyMap<string, Item>;
  profilesById: ReadonlyMap<string, Item>;
  /** CloudFront origin for /video/*, e.g. https://d123.cloudfront.net */
  playbackBase: string;
}

/** One content row → one contract item. */
export function libraryItemFor(row: Item, ctx: LibraryContext): DashboardLibraryItem {
  const source = record(row["source"]);
  const channelId = str(row["channelId"]);
  const channel = channelId ? ctx.channels.get(channelId) : undefined;
  const duration = row["duration"];
  return {
    content_id: String(row["id"] ?? String(row["PK"] ?? "").slice(CONTENT_PK_PREFIX.length)),
    ig_post_id: igPostIdFor(row),
    channel_id: channelId,
    channel_name: str(channel?.["name"]),
    title: typeof row["title"] === "string" ? row["title"] : "",
    caption: str(source["caption"]) ?? str(row["description"]),
    summary: str(row["summary"]),
    keywords: strings(row["keywords"]),
    sport: str(row["sport"]),
    school: str(row["school"]),
    content_type: str(row["contentType"]),
    content_types: strings(row["contentTypes"]),
    categories: strings(row["categories"]),
    sponsor: str(row["sponsor"]),
    athletes: athletesFor(row, ctx.profilesById),
    unresolved_handles: strings(row["unresolvedHandles"]),
    status: libraryStatus(row),
    qc_state: libraryQcState(row),
    poster_url: publicMediaUrl(row, "thumbUrl", "thumbPath", ctx.playbackBase),
    video_url: publicMediaUrl(row, "playbackUrl", "playbackPath", ctx.playbackBase),
    duration_sec: typeof duration === "number" && Number.isFinite(duration) && duration >= 0 ? duration : null,
    posted_at: isoOrNull(source["postedAt"]) ?? isoOrNull(row["sourcePostedAt"]) ?? isoOrNull(row["publishedAt"]),
    updated_at: updatedAtFor(row),
  };
}

/** The full snapshot body, items ordered by content id so repeat runs are byte-stable. */
export function buildLibrarySync(
  content: readonly Item[],
  ctx: LibraryContext,
  meta: { stage: "dev" | "prod"; generatedAt: Date },
): DashboardLibrarySync {
  const items = content
    .filter((row) => str(row["id"]) !== null)
    .map((row) => libraryItemFor(row, ctx))
    .sort((a, b) => (a.content_id < b.content_id ? -1 : a.content_id > b.content_id ? 1 : 0));
  return DashboardLibrarySync.parse({
    source: "niltv-app",
    stage: meta.stage,
    generated_at: meta.generatedAt.toISOString(),
    full: true,
    items,
  });
}

/* ── Run ──────────────────────────────────────────────────────────────────── */

export type LibrarySyncOutcome =
  | { status: "disabled" }
  | { status: "skipped"; reason: string; items?: number }
  | { status: "sent"; items: number; received: number; upserted: number; removed: number }
  | { status: "failed"; error: string; items?: number };

export interface LibrarySyncOptions {
  /** LIBRARY_SYNC_ENABLED === "true" */
  enabled: boolean;
  table: string;
  stage: string;
  playbackBase: string;
  dashboardUrl: string;
  now?: Date;
}

export interface LibrarySyncDeps {
  loadRows: (table: string) => Promise<LibraryRows>;
  loadProfiles: (table: string) => Promise<Item[]>;
  getApiKey: () => Promise<string>;
  fetch: typeof fetch;
}

export const defaultLibrarySyncDeps = (getApiKey: () => Promise<string>): LibrarySyncDeps => ({
  loadRows: scanLibraryRows,
  loadProfiles: allProfiles,
  getApiKey,
  fetch: (input, init) => fetch(input, init),
});

/** The one log line per run, key=value so a CloudWatch Insights `parse` can read it. */
export function librarySyncLogLine(outcome: LibrarySyncOutcome): string {
  switch (outcome.status) {
    case "disabled":
      return "library-sync: status=disabled";
    case "skipped":
      return `library-sync: status=skipped items=${outcome.items ?? 0} reason="${outcome.reason}"`;
    case "sent":
      return (
        `library-sync: status=sent items=${outcome.items} received=${outcome.received} ` +
        `upserted=${outcome.upserted} removed=${outcome.removed}`
      );
    case "failed":
      return `library-sync: status=failed items=${outcome.items ?? 0} error="${outcome.error.replace(/"/g, "'")}"`;
  }
}

/**
 * Build the snapshot and POST it once. Never throws: every failure becomes a
 * `failed` outcome, so the ingest run is never failed by the sync.
 */
export async function runLibrarySync(opts: LibrarySyncOptions, deps: LibrarySyncDeps): Promise<LibrarySyncOutcome> {
  const outcome = await attemptLibrarySync(opts, deps);
  const line = librarySyncLogLine(outcome);
  if (outcome.status === "failed") console.error(line);
  else console.log(line);
  return outcome;
}

async function attemptLibrarySync(opts: LibrarySyncOptions, deps: LibrarySyncDeps): Promise<LibrarySyncOutcome> {
  if (!opts.enabled) return { status: "disabled" };
  if (opts.stage !== "dev" && opts.stage !== "prod") {
    return { status: "skipped", reason: `stage ${opts.stage || "(unset)"} is not dev or prod` };
  }
  if (!opts.dashboardUrl) return { status: "skipped", reason: "LIBRARY_SYNC_URL unset" };

  let items: number | undefined;
  try {
    const [rows, profiles] = await Promise.all([deps.loadRows(opts.table), deps.loadProfiles(opts.table)]);
    items = rows.content.length;
    if (items > DASHBOARD_LIBRARY_SYNC_MAX_ITEMS) {
      // The dashboard answers 413 above the cap. Sending part of the library
      // with full=true would mark the rest removed, so skip the run loudly.
      console.error(
        `library-sync: ${items} content rows exceed the ${DASHBOARD_LIBRARY_SYNC_MAX_ITEMS}-item limit; ` +
          "chunked sync is needed before this can run",
      );
      return { status: "skipped", reason: "over item limit", items };
    }
    const profilesById = new Map<string, Item>();
    for (const p of profiles) if (typeof p["id"] === "string") profilesById.set(p["id"], p);
    const body = buildLibrarySync(
      rows.content,
      { channels: rows.channels, profilesById, playbackBase: opts.playbackBase },
      { stage: opts.stage, generatedAt: opts.now ?? new Date() },
    );
    items = body.items.length;

    const apiKey = await deps.getApiKey();
    const response = await deps.fetch(`${opts.dashboardUrl.replace(/\/+$/, "")}/api/library/sync`, {
      method: "POST",
      headers: { "X-API-Key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      const text = (await response.text().catch(() => "")).slice(0, 200);
      return { status: "failed", error: `HTTP ${response.status} ${text}`.trim(), items };
    }
    const parsed = DashboardLibrarySyncResponse.safeParse(await response.json().catch(() => undefined));
    if (!parsed.success) return { status: "failed", error: "unexpected response body", items };
    return { status: "sent", items, ...parsed.data };
  } catch (err) {
    return { status: "failed", error: err instanceof Error ? err.message : String(err), ...(items !== undefined ? { items } : {}) };
  }
}
