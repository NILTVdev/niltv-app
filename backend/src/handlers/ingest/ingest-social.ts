/**
 * ingest-social — the dashboard→app content bridge, and the PRIMARY content
 * path (staff uploads via the MediaConvert pipeline are for backlog drops and
 * custom content only).
 *
 * Scheduled hourly after the dashboard's Instagram pulls: reads
 * collected posts from the niltv_dashboard REST API (Postgres source of truth
 * for all brand/campus IG accounts) and, for each new VIDEO post, publishes
 * it directly — mp4 + IG poster frame mirrored into the HLS output bucket
 * (served by CloudFront at /video/*), duration read from the mp4 header, row
 * written already-published with the sparse GSI keys. No transcode: IG has
 * already compressed reels to mobile-friendly H.264 (~2-4 Mbps); re-encoding
 * short clips into an HLS ladder costs money and quality for ABR benefits
 * that don't apply at reel length.
 *
 * Mapping:
 *   dashboard account  → app channel `ch-{account}` (created on first sight,
 *                        kind "campus"; appended to CONFIG#app.channelIds so
 *                        the Watch tab lists it) — one app channel per campus.
 *   creator attribution → pseudo-profile `p-{account}` (channel-as-creator;
 *                        collab-athlete matching by IG handle is a future pass).
 *   dedupe             → content id `ig-{ig_post_id}`; existing row = skip;
 *                        tombstone (lib/db contentTombstone, `removed: true`)
 *                        = skip AND leave out of the content-library CSV, so
 *                        a post staff removed is never mirrored again.
 *   media              → IG media/thumbnail URLs are short-lived (hours), so
 *                        this must run soon after the dashboard pull; a post
 *                        whose URL has expired is skipped this run and retried
 *                        after the next pull refreshes it.
 *   post types         → VIDEO only (the bridge carries videos and reels only).
 *   publish            → auto-publish everything; rightsConfirmed stamped at
 *                        ingest; publishedAt = the source post's IG timestamp
 *                        so the feed orders by original post date.
 */
import { CreateJobCommand, MediaConvertClient } from "@aws-sdk/client-mediaconvert";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { Channel, Content, Profile } from "@niltv/types";
import type { ScheduledHandler } from "aws-lambda";
import { channelContentGsi1Pk, channelKey, configKey, contentKey, getDocClient, profileKey, schoolPolicyKey } from "../../lib/db";
import { type EnrichContext, applyEnrichment, profilesByHandle, type SchoolPolicy } from "../../lib/enrich";
import { allProfiles } from "../../lib/roster";
import type { Item } from "../../lib/shape";
import {
  averageMbps,
  buildOptimizeSettings,
  durationFromMvhd,
  needsOptimizing,
} from "../../lib/video-optimize";

/** Shape of a row from GET {DASHBOARD_API_URL}/api/brand/posts (FastAPI BrandPostOut). */
interface DashboardPost {
  account: string;
  ig_post_id: string;
  posted_at: string | null;
  media_type: string | null;
  caption: string | null;
  permalink: string | null;
  media_url: string | null;
  thumbnail_url: string | null;
  /** IG username of the original author (network posts) — future athlete matching. */
  source_author?: string | null;
}

/** Shape of a row from GET {DASHBOARD_API_URL}/api/brand/network/posts (collab posts). */
interface NetworkPost {
  post_id: string;
  account_username: string | null;
  description: string | null;
  publish_time: string | null;
  permalink: string | null;
  post_type: string | null;
  media_url: string | null;
  thumbnail_url: string | null;
  collab_accounts: string | null;
}

/**
 * Which app channel a collab post belongs to: prefer a campus channel over the
 * flagship (@niltv collabs across the whole network; the campus account is the
 * specific node). collab_accounts is a comma list of OUR accounts whose edges
 * carry the post, e.g. "niltv,starkvilletv" → starkvilletv.
 */
/**
 * The network's official channel roster: the ONLY accounts the
 * ingest may create channels or publish content for. The dashboard's pull
 * list can carry extra accounts. Their posts are skipped here so a stray
 * account can never put a channel up in the app.
 * scripts/ensure-channel-roster.ts holds the same list for the data side.
 */
export const CHANNEL_ROSTER = new Set([
  "niltv",
  "nilstar",
  "brazostv",
  "chapelhilltv",
  "collegestationtv",
  "truebluetv",
  "dorecitytv",
  "goldendometv",
  "goldsalemtv",
  "redpacktv",
  "saltcitytv",
  "starkvilletv",
]);

export function channelAccountFor(collabAccounts: string | null): string | undefined {
  const accounts = (collabAccounts ?? "")
    .split(",")
    .filter((a) => a.length > 0 && CHANNEL_ROSTER.has(a));
  if (accounts.length === 0) return undefined;
  return accounts.find((a) => a !== "niltv") ?? accounts[0];
}

/**
 * Collab post → the unified post shape (VIDEO/reel posts only), media or not.
 * Withheld posts (Instagram omits media_url for licensed audio) still shape —
 * they feed the content-library CSV as link-only rows.
 */
export function networkPostToPost(post: NetworkPost): DashboardPost | undefined {
  const account = channelAccountFor(post.collab_accounts);
  if (!account) return undefined;
  if (!/reel|video|igtv/i.test(post.post_type ?? "")) return undefined;
  return {
    account,
    ig_post_id: post.post_id,
    posted_at: post.publish_time,
    media_type: "VIDEO",
    caption: post.description,
    permalink: post.permalink,
    media_url: post.media_url,
    thumbnail_url: post.thumbnail_url,
    source_author: post.account_username,
  };
}

/** Collab post → the ingest candidate shape (mirrorable posts only). */
export function networkPostToCandidate(post: NetworkPost): DashboardPost | undefined {
  const shaped = networkPostToPost(post);
  return shaped?.media_url ? shaped : undefined;
}

/** Display names for known accounts; anything else gets capitalized as-is. */
const CHANNEL_NAMES: Record<string, string> = {
  niltv: "NIL TV",
  nilstar: "NIL Star",
  truebluetv: "TrueBlue TV",
  goldsalemtv: "Gold Salem TV",
  redtreetv: "Red Tree TV",
  collegestationtv: "College Station TV",
  goldsuntv: "Gold Sun TV",
  goldendometv: "Golden Dome TV",
  starkvilletv: "Starkville TV",
  dorecitytv: "Dore City TV",
  chapelhilltv: "Chapel Hill TV",
  brazostv: "Brazos TV",
  redpacktv: "Red Pack TV",
};

const displayName = (account: string): string =>
  CHANNEL_NAMES[account] ?? account.charAt(0).toUpperCase() + account.slice(1);

/**
 * Campus node → school (display form). Mirrors the site's channel map so the
 * school on a clip agrees everywhere; enrichment inherits it when no athlete
 * is credited. Flagship and NIL Star carry no school.
 */
export const ACCOUNT_SCHOOLS: Record<string, string> = {
  truebluetv: "Duke",
  dorecitytv: "Vanderbilt",
  chapelhilltv: "North Carolina",
  starkvilletv: "Mississippi State",
  collegestationtv: "Texas A&M",
  brazostv: "Baylor",
  goldendometv: "Notre Dame",
  redpacktv: "NC State",
  saltcitytv: "Syracuse",
  goldsalemtv: "Wake Forest",
};

/** ch-niltv is the seeded NIL TV channel; every other account gets a campus channel. */
const channelIdFor = (account: string): string => `ch-${account}`;
const profileIdFor = (account: string): string => `p-${account}`;

/**
 * First non-empty caption line, hashtags stripped from the tail, ≤80 chars.
 * A placeholder only: the enrichment pass that runs right after replaces it
 * (lib/enrich titleFor). An empty caption gives the channel's name, never a
 * "New on …" line, which would call the clip new for as long as it lives.
 */
export function titleFromCaption(caption: string | null, account: string): string {
  const firstLine = (caption ?? "")
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!firstLine) return displayName(account);
  const withoutTrailingTags = firstLine.replace(/(?:\s*#[\p{L}\p{N}_]+)+\s*$/u, "").trim();
  const base = withoutTrailingTags.length > 0 ? withoutTrailingTags : firstLine;
  return base.length <= 80 ? base : `${base.slice(0, 79).trimEnd()}…`;
}

/** posted_at (any ISO form) → contract IsoDate, or undefined when unparseable. */
export function toIsoDate(value: string | null): string | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

/**
 * What the existence check found for a candidate's CONTENT row. A tombstone
 * (lib/db contentTombstone: `removed: true`, no entity fields) is a row staff
 * removed on purpose; it must neither be re-mirrored nor listed in the
 * content-library CSV. Any other row counts as already ingested. Pure, so
 * the three-way branch is unit-testable without DynamoDB.
 */
export function existingRowDisposition(
  item: Record<string, unknown> | undefined,
): "absent" | "published" | "removed" {
  if (!item) return "absent";
  return item["removed"] === true ? "removed" : "published";
}

/** One row of the content-library CSV. A spreadsheet reads this file via
 * IMPORTDATA. */
export interface LibraryRow {
  postLink: string;
  downloadLink: string;
  account: string;
  caption: string;
  posted: string;
}

/** Original IG author, with our channel appended when they differ. */
export function libraryAccountLine(post: DashboardPost): string {
  const author = (post.source_author ?? "").trim();
  if (author && author !== post.account) return `@${author} (via ${post.account})`;
  return `@${post.account}`;
}

/** Stands in for newlines inside CSV fields: Google's IMPORTDATA splits rows
 * on raw newlines even when quoted, so the sheet formula restores CHAR(10)
 * from this marker instead. */
export const CSV_NEWLINE_MARK = "⏎";

/** CSV field: newlines → marker, quotes doubled, wrapped when needed. */
export function csvField(value: string): string {
  const flat = value.replace(/\r/g, "").replace(/\n/g, CSV_NEWLINE_MARK);
  return flat.includes(",") || flat.includes('"') || flat.includes(CSV_NEWLINE_MARK)
    ? `"${flat.replace(/"/g, '""')}"`
    : flat;
}

export function buildLibraryCsv(rows: LibraryRow[]): string {
  const lines = rows.map((r) =>
    [r.postLink, r.downloadLink, r.account, r.caption, r.posted].map(csvField).join(","),
  );
  return ["Post Link,Download Link,Account / Collaborators,Caption,Posted", ...lines, ""].join("\n");
}

export function libraryRowFor(post: DashboardPost, playbackBase: string): LibraryRow {
  return {
    postLink: post.permalink ?? "",
    downloadLink: `${playbackBase}/video/ig-${post.ig_post_id}/master.mp4`,
    account: libraryAccountLine(post),
    caption: (post.caption ?? "").trim(),
    posted: (toIsoDate(post.posted_at) ?? "").slice(0, 10),
  };
}

/**
 * Withheld posts: Instagram omits media_url when a reel carries
 * licensed audio, so there is nothing to mirror — but the sheet still lists
 * the post with its Instagram link and an EMPTY Download Link, so sorting by
 * date shows exactly which videos have an ingest download and which don't.
 */
export function libraryRowForWithheld(post: DashboardPost): LibraryRow {
  return {
    postLink: post.permalink ?? "",
    downloadLink: "",
    account: libraryAccountLine(post),
    caption: (post.caption ?? "").trim(),
    posted: (toIsoDate(post.posted_at) ?? "").slice(0, 10),
  };
}

/** Whole sheet newest-first — candidates and withheld interleave by date. */
export function sortLibraryRows(rows: LibraryRow[]): LibraryRow[] {
  return [...rows].sort((a, b) => (a.posted < b.posted ? 1 : a.posted > b.posted ? -1 : 0));
}

/**
 * Publish the content-library CSV to `library/` — NOT `video/`, whose edge
 * behaviour stamps a year-long immutable Cache-Control; /library/* honours
 * the object's own five-minute max-age so the sheet refreshes after every
 * run. Best-effort by design: a CSV failure must never fail the ingest run.
 */
async function writeContentLibrary(outputBucket: string, rows: LibraryRow[]): Promise<void> {
  try {
    await getS3().send(
      new PutObjectCommand({
        Bucket: outputBucket,
        Key: "library/content-library.csv",
        Body: buildLibraryCsv(rows),
        ContentType: "text/csv; charset=utf-8",
        CacheControl: "public, max-age=300",
      }),
    );
    console.log(`ingest-social: content-library.csv published (${rows.length} rows)`);
  } catch (err) {
    console.error("ingest-social: content-library.csv write failed", err);
  }
}

/**
 * Whole seconds from an MP4's moov/mvhd box, or undefined when absent/mangled.
 * IG serves faststart files (moov up front), but this scans the whole buffer
 * so trailing-moov files work too. mvhd layout after the 4-byte type tag:
 * version(1) flags(3), then v0: created(4) modified(4) timescale(4) duration(4);
 * v1 widens created/modified/duration to 8 bytes.
 */
export function mp4DurationSec(buffer: Buffer): number | undefined {
  // Whole seconds for the Content.duration contract field. The exact
  // (fractional) value comes from the shared parser, which the re-compression
  // path also uses to measure bitrate — one mvhd reader, not two.
  const seconds = durationFromMvhd(buffer);
  return seconds === null ? undefined : Math.round(seconds);
}

/**
 * Submit a re-compression job when a freshly mirrored clip is over-encoded.
 *
 * Best-effort by design: the clip is already published and playable, so a
 * failure here must never fail the ingest run. The original is archived to the
 * masters bucket under `originals/` first — that archive is the job's input,
 * so the served object is only ever overwritten by an encode of the pristine
 * source, and the job is repeatable. `originals/` deliberately avoids the
 * `masters/` prefix, which would trigger the unrelated HLS pipeline.
 *
 * Exported for testing.
 */
export async function queueRecompressionIfOverEncoded(
  contentId: string,
  bytes: Buffer,
  outputBucket: string,
): Promise<boolean> {
  const mastersBucket = process.env.MASTERS_BUCKET;
  const roleArn = process.env.MEDIACONVERT_ROLE_ARN;
  const queueArn = process.env.MEDIACONVERT_QUEUE_ARN;
  if (!mastersBucket || !roleArn) return false;

  const mbps = averageMbps(bytes.length, durationFromMvhd(bytes));
  if (!needsOptimizing(mbps)) return false;

  try {
    const archiveKey = `originals/${contentId}/master.mp4`;
    await getS3().send(
      new PutObjectCommand({
        Bucket: mastersBucket,
        Key: archiveKey,
        Body: bytes,
        ContentType: "video/mp4",
      }),
    );
    await getMediaConvert().send(
      new CreateJobCommand({
        Role: roleArn,
        Queue: queueArn,
        Settings: buildOptimizeSettings(
          `s3://${mastersBucket}/${archiveKey}`,
          `s3://${outputBucket}/video/${contentId}/master`,
        ),
        UserMetadata: { contentId, stage: process.env.STAGE ?? "dev", purpose: "optimize" },
      }),
    );
    console.log(
      `ingest-social: queued re-compression for ${contentId} (${mbps?.toFixed(2)} Mbps)`,
    );
    return true;
  } catch (err) {
    console.error(`ingest-social: re-compression for ${contentId} could not be queued`, err);
    return false;
  }
}

let s3Client: S3Client | undefined;
let mediaConvertClient: MediaConvertClient | undefined;

function getMediaConvert(): MediaConvertClient {
  if (!mediaConvertClient) {
    mediaConvertClient = new MediaConvertClient({ region: process.env.AWS_REGION ?? "us-east-1" });
  }
  return mediaConvertClient;
}
const getS3 = (): S3Client => (s3Client ??= new S3Client({}));

let cachedApiKey: string | undefined;
async function getDashboardApiKey(): Promise<string> {
  if (cachedApiKey) return cachedApiKey;
  const paramName = process.env.DASHBOARD_API_KEY_PARAM ?? "";
  const out = await new SSMClient({}).send(
    new GetParameterCommand({ Name: paramName, WithDecryption: true }),
  );
  const value = out.Parameter?.Value;
  if (!value) throw new Error(`SSM parameter ${paramName} is empty — cannot call the dashboard API`);
  cachedApiKey = value;
  return value;
}

async function fetchDashboard<T>(path: string): Promise<T[]> {
  const baseUrl = process.env.DASHBOARD_API_URL ?? "";
  const apiKey = await getDashboardApiKey();
  const response = await fetch(`${baseUrl}${path}`, { headers: { "X-API-Key": apiKey } });
  if (!response.ok) {
    throw new Error(`dashboard API ${response.status} on ${path}: ${(await response.text()).slice(0, 200)}`);
  }
  return (await response.json()) as T[];
}

/**
 * Owned posts (brand accounts' /media) + collab posts (network table, the
 * athlete-collab pipeline), unified and deduped — owned wins on overlap so a
 * clip our channel authored keeps its home-channel attribution.
 */
async function fetchCandidates(): Promise<{
  candidates: DashboardPost[];
  withheld: DashboardPost[];
}> {
  // Max limits — the network table spans the whole collab history and older
  // posts must stay in the candidate set (they drain under the per-run cap).
  const [brand, network] = await Promise.all([
    fetchDashboard<DashboardPost>("/api/brand/posts?account=all&limit=1000"),
    fetchDashboard<NetworkPost>("/api/brand/network/posts?limit=2000"),
  ]);

  const byId = new Map<string, DashboardPost>();
  const withheldById = new Map<string, DashboardPost>();
  let offRoster = 0;
  for (const post of brand) {
    if (post.media_type !== "VIDEO" || !post.ig_post_id) continue;
    if (!CHANNEL_ROSTER.has(post.account)) {
      offRoster += 1;
      continue;
    }
    if (post.media_url) byId.set(post.ig_post_id, post);
    else withheldById.set(post.ig_post_id, post);
  }
  let collabCandidates = 0;
  for (const post of network) {
    const shaped = networkPostToPost(post);
    if (!shaped || byId.has(shaped.ig_post_id)) continue;
    if (shaped.media_url) {
      byId.set(shaped.ig_post_id, shaped);
      collabCandidates += 1;
    } else if (!withheldById.has(shaped.ig_post_id)) {
      withheldById.set(shaped.ig_post_id, shaped);
    }
  }
  // A post with media anywhere is a candidate, never withheld.
  for (const id of byId.keys()) withheldById.delete(id);
  console.log(
    `ingest-social: ${byId.size} video candidates (${byId.size - collabCandidates} owned, ` +
      `${collabCandidates} collab) + ${withheldById.size} withheld (no media_url) ` +
      `from ${brand.length} brand + ${network.length} network posts` +
      (offRoster > 0 ? ` (${offRoster} off-roster brand posts skipped)` : ""),
  );

  // Newest first — the per-run cap should always favor fresh content.
  const newestFirst = (a: DashboardPost, b: DashboardPost) =>
    String(b.posted_at ?? "").localeCompare(String(a.posted_at ?? ""));
  return {
    candidates: [...byId.values()].sort(newestFirst),
    withheld: [...withheldById.values()].sort(newestFirst),
  };
}

/** Channels/profiles already ensured this invocation (and the CONFIG list state). */
interface EnsureCache {
  channels: Set<string>;
  profiles: Set<string>;
}

/**
 * Everything the enrichment pass needs, loaded once per run: real athlete
 * profiles by handle (roster sync), the school-marks policy, and the set of
 * our own account handles so a mention of @niltv is never "a person".
 */
export interface EnrichRun {
  profilesByHandle: Map<string, Item>;
  ownAccounts: Set<string>;
  ignoreHandles: Set<string>;
  schoolPolicy: SchoolPolicy;
}

/** Handles our own accounts have used or that mirror them — never people. */
export const OWN_ACCOUNT_ALIASES = ["trueblue_tv", "nil.tv", "nil_tv", "niltv_", "nil.star", "nil_star"];

export async function loadEnrichRun(table: string, accounts: Iterable<string>): Promise<EnrichRun> {
  const profiles = await allProfiles(table);
  const { Item: policy } = await getDocClient().send(new GetCommand({ TableName: table, Key: schoolPolicyKey() }));
  const blocked = Array.isArray(policy?.["blockedSchools"]) ? (policy!["blockedSchools"] as string[]) : [];
  const ignore = Array.isArray(policy?.["ignoreHandles"]) ? (policy!["ignoreHandles"] as string[]) : [];
  return {
    profilesByHandle: profilesByHandle(profiles.filter((p) => !String(p["id"]).startsWith("p-"))),
    ownAccounts: new Set([...Object.keys(CHANNEL_NAMES), ...OWN_ACCOUNT_ALIASES, ...accounts].map((a) => a.toLowerCase())),
    ignoreHandles: new Set(ignore.map((h) => h.toLowerCase())),
    schoolPolicy: { blockedSchools: blocked },
  };
}

/** The immutable source record for an Instagram post (owned or collab). */
export function sourceFor(post: DashboardPost): Item {
  return {
    kind: post.source_author && post.source_author !== post.account ? "instagram-collab" : "instagram-owned",
    account: post.account,
    ...(post.source_author ? { authorHandle: post.source_author.toLowerCase().replace(/^@/, "") } : {}),
    postId: post.ig_post_id,
    ...(post.permalink ? { url: post.permalink } : {}),
    ...(toIsoDate(post.posted_at) ? { postedAt: toIsoDate(post.posted_at) } : {}),
    caption: post.caption ?? "",
    mediaType: post.media_type ?? "VIDEO",
  };
}

async function ensureChannel(table: string, account: string, cache: EnsureCache): Promise<string> {
  const channelId = channelIdFor(account);
  if (cache.channels.has(channelId)) return channelId;
  const db = getDocClient();

  const existing = await db.send(new GetCommand({ TableName: table, Key: channelKey(channelId) }));
  if (!existing.Item) {
    const channel = Channel.parse({
      id: channelId,
      name: displayName(account),
      kind: account === "niltv" ? "niltv" : "campus",
      about: `Clips from @${account} on Instagram.`,
      account,
      ...(ACCOUNT_SCHOOLS[account] ? { school: ACCOUNT_SCHOOLS[account] } : {}),
    });
    await db.send(
      new PutCommand({
        TableName: table,
        Item: { ...channelKey(channelId), ...channel },
        ConditionExpression: "attribute_not_exists(PK)",
      }),
    );

    // Surface the new channel in the Watch tab: append to CONFIG#app.channelIds
    // (the public channels handler falls back to the seed trio when unset, so
    // seed the trio first to keep them listed). Single-writer in practice.
    const { Item: config } = await db.send(new GetCommand({ TableName: table, Key: configKey() }));
    const configured = config?.["channelIds"];
    const ids: string[] =
      Array.isArray(configured) && configured.every((id) => typeof id === "string") && configured.length > 0
        ? [...(configured as string[])]
        : ["ch-trueblue", "ch-niltv", "ch-esports"];
    if (!ids.includes(channelId)) {
      ids.push(channelId);
      await db.send(
        new UpdateCommand({
          TableName: table,
          Key: configKey(),
          UpdateExpression: "SET channelIds = :ids",
          ExpressionAttributeValues: { ":ids": ids },
        }),
      );
    }
    console.log(`ingest-social: created channel ${channelId} ("${displayName(account)}")`);
  }
  cache.channels.add(channelId);
  return channelId;
}

async function ensureProfile(table: string, account: string, cache: EnsureCache): Promise<string> {
  const profileId = profileIdFor(account);
  if (cache.profiles.has(profileId)) return profileId;
  const db = getDocClient();

  const existing = await db.send(new GetCommand({ TableName: table, Key: profileKey(profileId) }));
  if (!existing.Item) {
    // Channel-as-creator pseudo-profile: carries the creator line on cards.
    // No PROFILES#ALL GSI keys, so it never appears in the athlete directory.
    const profile = Profile.parse({
      id: profileId,
      name: displayName(account),
      handle: account,
      school: "",
      sport: "",
      bio: `Official ${displayName(account)} channel.`,
    });
    await db.send(
      new PutCommand({
        TableName: table,
        Item: { ...profileKey(profileId), ...profile },
        ConditionExpression: "attribute_not_exists(PK)",
      }),
    );
    console.log(`ingest-social: created creator profile ${profileId}`);
  }
  cache.profiles.add(profileId);
  return profileId;
}

/**
 * Mirror one post and publish it: mp4 + poster into the CloudFront-served
 * output bucket, duration from the mp4 header, row written already-published.
 */
async function ingestPost(
  table: string,
  outputBucket: string,
  post: DashboardPost,
  cache: EnsureCache,
  run: EnrichRun,
): Promise<boolean> {
  const contentId = `ig-${post.ig_post_id}`;

  // Download FIRST: if the media URL has already expired, skip without leaving
  // an orphan row — the next dashboard pull refreshes media_url and we retry.
  const media = await fetch(post.media_url ?? "");
  if (!media.ok) {
    console.log(`ingest-social: media fetch ${media.status} for ${contentId} (${post.account}) — retrying next run`);
    return false;
  }
  // The scraper falls back to thumbnail_url when IG withholds media_url
  // (e.g. copyrighted audio) — never publish an image as a video.
  const contentType = media.headers.get("content-type") ?? "";
  if (!contentType.startsWith("video/")) {
    console.log(`ingest-social: ${contentId} media is ${contentType || "unknown"} not video — skipping`);
    return false;
  }
  const bytes = Buffer.from(await media.arrayBuffer());

  // Poster frame — best-effort; a missing poster falls back to the app's
  // gradient card, never blocks the video.
  let posterBytes: Buffer | undefined;
  if (post.thumbnail_url) {
    try {
      const poster = await fetch(post.thumbnail_url);
      if (poster.ok && (poster.headers.get("content-type") ?? "").startsWith("image/")) {
        posterBytes = Buffer.from(await poster.arrayBuffer());
      }
    } catch {
      posterBytes = undefined;
    }
  }

  const channelId = await ensureChannel(table, post.account, cache);
  const athleteId = await ensureProfile(table, post.account, cache);

  const s3 = getS3();
  await s3.send(
    new PutObjectCommand({
      Bucket: outputBucket,
      Key: `video/${contentId}/master.mp4`,
      Body: bytes,
      ContentType: "video/mp4",
      CacheControl: "public, max-age=31536000, immutable",
    }),
  );
  if (posterBytes) {
    await s3.send(
      new PutObjectCommand({
        Bucket: outputBucket,
        Key: `video/${contentId}/poster.jpg`,
        Body: posterBytes,
        ContentType: "image/jpeg",
        CacheControl: "public, max-age=31536000, immutable",
      }),
    );
  }

  // Instagram hands back whatever the creator's phone encoded, and a
  // meaningful share of it runs 4–6 Mbps at 720x1280 — three times what the
  // picture needs, which is what stalls the feed on cellular. The clip is
  // published either way (it plays, just heavily); the re-compression lands
  // under the same key a few minutes later and the row never changes.
  await queueRecompressionIfOverEncoded(contentId, bytes, outputBucket);

  const publishedAt = toIsoDate(post.posted_at) ?? new Date().toISOString();
  const entity = Content.parse({
    id: contentId,
    title: titleFromCaption(post.caption, post.account),
    channelId,
    athleteId,
    description: post.caption ?? "",
    provider: "hls",
    transcodeStatus: "published",
    rightsConfirmed: true, // bridge decision: auto-publish everything
    duration: mp4DurationSec(bytes),
    publishedAt,
    sourcePlatform: "instagram",
    sourcePostId: post.ig_post_id,
    sourceUrl: post.permalink ?? undefined,
  });
  // Enrichment (content foundation): the source record is written once,
  // verbatim; title, description, classification, the athlete credit and the
  // rights defaults are derived from it and can be recomputed at any time.
  // The app keeps auto-publishing exactly as before; only the partner surface
  // waits on what the pass could not derive.
  const ctx: EnrichContext = {
    profilesByHandle: run.profilesByHandle,
    ownAccounts: run.ownAccounts,
    ignoreHandles: run.ignoreHandles,
    channelName: displayName(post.account),
    ...(ACCOUNT_SCHOOLS[post.account] ? { accountSchool: ACCOUNT_SCHOOLS[post.account] } : {}),
    schoolPolicy: run.schoolPolicy,
  };
  const enriched = applyEnrichment(
    {
      ...entity,
      playbackPath: `/video/${contentId}/master.mp4`,
      ...(posterBytes ? { thumbPath: `/video/${contentId}/poster.jpg` } : {}),
      source: sourceFor(post),
    },
    ctx,
  );
  // The creator credit: a resolved athlete, else the channel pseudo-profile.
  const creditId = typeof enriched["athleteId"] === "string" && !String(enriched["athleteId"]).startsWith("p-") ? String(enriched["athleteId"]) : athleteId;
  await getDocClient().send(
    new PutCommand({
      TableName: table,
      Item: {
        ...contentKey(contentId),
        ...enriched,
        athleteId: creditId,
        // Original author's IG handle (collab posts) — kept for older readers.
        ...(post.source_author ? { sourceAuthor: post.source_author } : {}),
        sourcePostedAt: toIsoDate(post.posted_at),
        // Published rows carry the sparse GSI keys (Watch grid + creator tab).
        GSI1PK: channelContentGsi1Pk(channelId),
        GSI1SK: publishedAt,
        GSI2PK: profileKey(creditId).PK,
        GSI2SK: publishedAt,
      },
      ConditionExpression: "attribute_not_exists(PK)",
    }),
  );
  console.log(
    `ingest-social: published ${contentId} (${post.account}, ${bytes.length} bytes, ` +
      `poster=${posterBytes ? "yes" : "no"}, duration=${entity.duration ?? "?"}s)`,
  );
  return true;
}

/**
 * Event-driven site deploy. After a run that mirrored new clips, dispatch the
 * site's deploy workflow so the site rebuilds now instead of on its next
 * scheduled build. The token is read from SSM. When the parameter is unset or
 * the call fails, the run still succeeds and the scheduled build picks the
 * change up later.
 */
async function dispatchSiteDeploy(published: number): Promise<void> {
  const paramName = process.env.SITE_DEPLOY_TOKEN_PARAM ?? "";
  const repo = process.env.SITE_DEPLOY_REPO ?? "";
  if (!paramName || !repo || published === 0) return;
  try {
    const out = await new SSMClient({}).send(new GetParameterCommand({ Name: paramName, WithDecryption: true }));
    const token = out.Parameter?.Value ?? "";
    if (!token) {
      console.log("ingest-social: site deploy token is empty; dispatch skipped");
      return;
    }
    const res = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/deploy-prod.yml/dispatches`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ref: "release", inputs: {} }),
      signal: AbortSignal.timeout(15_000),
    });
    console.log(`ingest-social: site deploy dispatched for ${published} new clip(s) -> HTTP ${res.status}`);
  } catch (err) {
    console.error("ingest-social: site deploy dispatch failed (the schedule will catch up)", err);
  }
}

export const handler: ScheduledHandler = async () => {
  const table = process.env.TABLE_NAME ?? "";
  const outputBucket = process.env.OUTPUT_BUCKET ?? "";
  const maxNewPerRun = Number(process.env.MAX_NEW_PER_RUN ?? "50");

  const playbackBase = process.env.PLAYBACK_BASE_URL ?? "";

  const { candidates, withheld } = await fetchCandidates();

  const cache: EnsureCache = { channels: new Set(), profiles: new Set() };
  const run = await loadEnrichRun(table, candidates.map((c) => c.account));
  const db = getDocClient();
  const libraryRows: LibraryRow[] = [];
  let ingested = 0;
  let skippedExisting = 0;
  let skippedRemoved = 0;
  let failed = 0;
  let deferred = 0;

  // Newest first (the dashboard already orders posted_at DESC); the per-run cap
  // bounds new mirrors — older backlog drains over subsequent hourly runs. The
  // existence sweep deliberately continues past the cap so the content-library
  // CSV still reflects the complete published set every run.
  for (const post of candidates) {
    const { Item: existing } = await db.send(
      new GetCommand({
        TableName: table,
        Key: contentKey(`ig-${post.ig_post_id}`),
        // `removed` is aliased rather than trusted to be an unreserved word.
        ProjectionExpression: "PK, #removed",
        ExpressionAttributeNames: { "#removed": "removed" },
      }),
    );
    const disposition = existingRowDisposition(existing);
    if (disposition === "removed") {
      // Staff tombstone (lib/db contentTombstone): never re-mirror, and keep
      // it out of the content-library CSV. Without this check a removed post
      // would come back on the next run.
      skippedRemoved += 1;
      continue;
    }
    if (disposition === "published") {
      skippedExisting += 1;
      libraryRows.push(libraryRowFor(post, playbackBase));
      continue;
    }
    if (ingested >= maxNewPerRun) {
      deferred += 1;
      continue;
    }

    try {
      if (await ingestPost(table, outputBucket, post, cache, run)) {
        ingested += 1;
        libraryRows.push(libraryRowFor(post, playbackBase));
      } else {
        failed += 1;
      }
    } catch (err) {
      failed += 1;
      console.error(`ingest-social: failed on ig-${post.ig_post_id} (${post.account})`, err);
    }
  }

  if (playbackBase) {
    // Withheld posts ride along as link-only rows (empty Download Link), and
    // the whole sheet sorts newest-first so mirrored vs link-only interleave
    // by date.
    const withheldRows = withheld.map((post) => libraryRowForWithheld(post));
    await writeContentLibrary(outputBucket, sortLibraryRows([...libraryRows, ...withheldRows]));
  } else {
    console.log("ingest-social: PLAYBACK_BASE_URL unset — content-library.csv skipped");
  }

  console.log(
    `ingest-social: done — ${ingested} mirrored, ${skippedExisting} already ingested, ` +
      `${skippedRemoved} tombstoned, ${failed} failed/retrying, ${deferred} deferred by cap, ` +
      `${candidates.length} video candidates`,
  );

  await dispatchSiteDeploy(ingested);
};
