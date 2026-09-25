/**
 * Syndication rules (partner content API) — the ONE place that decides what
 * may leave the platform, and how a content row becomes the asset a partner
 * sees. The feed builder, the partner API, the admin eligibility badge and
 * the tests all call these; nothing else re-implements the rule.
 *
 * Everything here is pure: raw DynamoDB items in, contract shapes out, no
 * AWS client. Signing is injected (see partner-signing.ts).
 */
import {
  ContentRights,
  type Partner,
  type PartnerAsset,
  type PartnerFile,
  type PlatformId,
} from "@niltv/types";
import { syndicationGsi } from "./db";
import type { Item } from "./shape";

/* ── Rights ───────────────────────────────────────────────────────────────── */

/** True when the value is a plain object (not null, not an array). */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The effective rights record: the series' defaults with the row's own
 * values layered on top, then the schema's conservative defaults for anything
 * still unset. A row with no record and no series is `restricted / unknown`.
 */
export function rightsOf(row: Item, series?: Item): ContentRights {
  const seriesDefaults = isRecord(series?.["defaultRights"]) ? series["defaultRights"] : {};
  const own = isRecord(row["rights"]) ? row["rights"] : {};
  const merged: Record<string, unknown> = { ...seriesDefaults };
  for (const [key, value] of Object.entries(own)) {
    if (value !== undefined && value !== null) merged[key] = value;
  }
  return ContentRights.parse(merged);
}

const DAY_MS = 86_400_000;

/** Earliest instant the asset may syndicate: the record's own date, else publish date plus the series delay. */
export function availableFromOf(row: Item, series?: Item): string | undefined {
  const rights = rightsOf(row, series);
  if (rights.availableFrom) return rights.availableFrom;
  const publishedAt = row["publishedAt"];
  if (typeof publishedAt !== "string" || publishedAt.length === 0) return undefined;
  const delayDays = typeof series?.["syndicationDelayDays"] === "number" ? series["syndicationDelayDays"] : 0;
  if (delayDays <= 0) return publishedAt;
  return new Date(Date.parse(publishedAt) + delayDays * DAY_MS).toISOString();
}

export interface Eligibility {
  eligible: boolean;
  /** human reasons, empty when eligible — surfaced on the admin badge */
  reasons: string[];
}

const eligibility = (reasons: string[]): Eligibility => ({ eligible: reasons.length === 0, reasons });

/**
 * Partner-independent part of the rule: is this row allowed off-platform at
 * all, right now? Withdrawn rows fail here (they still exist in the index as
 * tombstones — see /changes).
 */
export function baseEligibility(row: Item, series?: Item, now: Date = new Date()): Eligibility {
  const reasons: string[] = [];
  const publishedAt = row["publishedAt"];
  if (row["transcodeStatus"] !== "published" || typeof publishedAt !== "string" || publishedAt.length === 0) {
    reasons.push("not published");
  }
  if (row["removed"] === true) reasons.push("removed");
  if (typeof row["withdrawnAt"] === "string") reasons.push("withdrawn");

  const rights = rightsOf(row, series);
  if (rights.status !== "owned" && rights.status !== "licensed") reasons.push(`rights status is ${rights.status}`);
  if (!rights.logoCleared) reasons.push("school marks not cleared");
  if (rights.music !== "none" && rights.music !== "cleared") reasons.push(`music is ${rights.music}`);

  // Availability windows (rights.availableFrom, the series delay) are not
  // enforced here: an asset is available once it is ingested.
  if (rights.expiresAt && Date.parse(rights.expiresAt) <= now.getTime()) reasons.push("expired");

  if (!resolveSyndicationFiles(row)) reasons.push("no downloadable file");
  return eligibility(reasons);
}

/** Partner-specific part of the rule: has THIS partner licensed this row, and is its term open? */
export function partnerScope(row: Item, partner: Partner, now: Date = new Date()): Eligibility {
  const reasons: string[] = [];
  if (partner.status !== "active") reasons.push("partner suspended");
  const { licence } = partner;
  if (licence.termStart && Date.parse(licence.termStart) > now.getTime()) reasons.push("licence term not started");
  if (licence.termEnd && Date.parse(licence.termEnd) <= now.getTime()) reasons.push("licence term ended");

  const seriesId = typeof row["seriesId"] === "string" ? row["seriesId"] : undefined;
  const channelId = typeof row["channelId"] === "string" ? row["channelId"] : undefined;
  const inSeries = seriesId !== undefined && licence.seriesIds.includes(seriesId);
  const inChannel = channelId !== undefined && licence.channelIds.includes(channelId);
  if (!inSeries && !inChannel) reasons.push("not licensed to this partner");

  const assetType = assetTypeOf(row);
  if (!licence.assetTypes.includes(assetType)) reasons.push(`asset type ${assetType} not licensed`);
  return eligibility(reasons);
}

/** The whole rule. */
export function isSyndicable(row: Item, series: Item | undefined, partner: Partner, now: Date = new Date()): Eligibility {
  const base = baseEligibility(row, series, now);
  const scope = partnerScope(row, partner, now);
  return eligibility([...base.reasons, ...scope.reasons]);
}

/**
 * Should this row carry GSI3 keys? Candidates are rows that have been
 * published with an owned/licensed rights record. Withdrawn rows stay in
 * (tombstones); rights flipped back to restricted drop out.
 */
export function isIndexCandidate(row: Item, series?: Item): boolean {
  const publishedAt = row["publishedAt"];
  if (typeof publishedAt !== "string" || publishedAt.length === 0) return false;
  if (row["removed"] === true) return false;
  const status = rightsOf(row, series).status;
  return status === "owned" || status === "licensed";
}

/** GSI3 attributes for a row, or undefined when the row must not be indexed. */
export function syndicationIndexKeys(
  row: Item,
  series?: Item,
): { GSI3PK: string; GSI3SK: string } | undefined {
  if (!isIndexCandidate(row, series)) return undefined;
  const updatedAt = syndicationUpdatedAtOf(row);
  return updatedAt ? syndicationGsi(updatedAt, String(row["id"])) : undefined;
}

/** The version stamp partners re-fetch on: the syndication edit stamp, else the publish date. */
export function syndicationUpdatedAtOf(row: Item): string | undefined {
  const stamp = row["syndicationUpdatedAt"];
  if (typeof stamp === "string" && stamp.length > 0) return stamp;
  const publishedAt = row["publishedAt"];
  return typeof publishedAt === "string" && publishedAt.length > 0 ? publishedAt : undefined;
}

export const assetTypeOf = (row: Item): "episode" | "clip" | "short" => {
  const value = row["assetType"];
  return value === "episode" || value === "short" ? value : "clip";
};

/* ── Files ────────────────────────────────────────────────────────────────── */

/**
 * Domain-less paths on the partner download distribution. The distribution's
 * default origin is the video bucket with origin path `/video`, so
 * `/{id}/master.mp4` is the social clip's stored MP4; `/masters/*` and
 * `/originals/*` route to the masters bucket.
 */
export interface SyndicationPaths {
  mp4: string;
  vertical?: string;
  /** the untouched upload or archived original, when it differs from mp4 */
  source?: string;
  poster?: string;
  captions?: string;
}

const VIDEO_PREFIX = "/video/";

/** `/video/{id}/x` → `/{id}/x` (the partner distribution's origin path supplies `/video`). */
const stripVideoPrefix = (path: unknown): string | undefined => {
  if (typeof path !== "string" || !path.startsWith(VIDEO_PREFIX)) return undefined;
  return path.slice(VIDEO_PREFIX.length - 1);
};

/** True for rows the MediaConvert pipeline produced (an HLS manifest): their upload sits in the masters bucket. */
const isUploaded = (row: Item): boolean =>
  typeof row["playbackPath"] === "string" && row["playbackPath"].endsWith(".m3u8");

export function resolveSyndicationFiles(row: Item): SyndicationPaths | undefined {
  const id = row["id"];
  if (typeof id !== "string" || id.length === 0) return undefined;
  const files = isRecord(row["files"]) ? row["files"] : {};
  const str = (key: string): string | undefined =>
    typeof files[key] === "string" && (files[key] as string).length > 0 ? (files[key] as string) : undefined;

  const uploadedMaster = isUploaded(row) ? `/masters/${id}/master.mp4` : undefined;
  const socialMp4 = (() => {
    const playback = row["playbackPath"];
    return typeof playback === "string" && playback.endsWith("/master.mp4") ? stripVideoPrefix(playback) : undefined;
  })();

  const mp4 = str("mp4Path") ?? uploadedMaster ?? socialMp4;
  if (!mp4) return undefined;

  // The original is only "source" when it is a different file from mp4.
  const explicitSource = str("sourcePath");
  const source = explicitSource ?? (str("mp4Path") && uploadedMaster ? uploadedMaster : undefined);

  const poster = str("posterPath") ?? stripVideoPrefix(row["thumbPath"]);
  const out: SyndicationPaths = { mp4 };
  if (str("verticalPath")) out.vertical = str("verticalPath");
  if (source && source !== mp4) out.source = source;
  if (poster) out.poster = poster;
  if (str("captionsPath")) out.captions = str("captionsPath");
  return out;
}

/** MIME type from a path's extension — what a partner's ingest validates before downloading. */
export function mimeOf(path: string): string {
  const ext = path.toLowerCase().split(".").pop() ?? "";
  switch (ext) {
    case "mp4":
    case "m4v":
      return "video/mp4";
    case "mov":
      return "video/quicktime";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "vtt":
      return "text/vtt";
    case "srt":
      return "application/x-subrip";
    default:
      return "application/octet-stream";
  }
}

/* ── Title and description hygiene ────────────────────────────────────────── */

// Emoji and pictographs (plus the joiners/selectors that glue them together).
const EMOJI = /[\p{Extended_Pictographic}\u{FE0F}\u{200D}\u{20E3}]/gu;
const URL = /https?:\/\/\S+/gi;
const HANDLE = /(^|\s)@[\w.]+/g;
const HASHTAG = /(^|\s)#[\p{L}\p{N}_]+/gu;
const HTML_TAG = /<[^>]+>/g;
const TRAILING_JUNK = /[\s\-–—|:;,·•.]+$/u;
const LEADING_JUNK = /^[\s\-–—|:;,·•.]+/u;

const collapse = (value: string): string => value.replace(/\s+/g, " ").trim();

/** Words in a cleaned line: space-separated tokens carrying a letter or digit. */
export const titleWords = (text: string): string[] => text.split(" ").filter((w) => /[\p{L}\p{N}]/u.test(w));

/**
 * The cleaned first line of a caption, before any word-count rule: links,
 * handles, hashtags, emoji and markup stripped, the first sentence kept, the
 * length capped at a word boundary. Empty when nothing readable survives.
 */
export function titleCandidate(raw: string, maxLength = 120): string {
  // A caption's first non-empty line is the title candidate; later lines are
  // credits, hashtags and calls to action (verified against 650 real rows).
  const firstLine = raw
    .split(/\r?\n/)
    .map((line) => line.replace(HASHTAG, " ").replace(HANDLE, " ").replace(EMOJI, "").trim())
    .find((line) => /[\p{L}\p{N}]/u.test(line));
  let text = collapse((firstLine ?? raw).replace(HTML_TAG, " ").replace(URL, " ").replace(HANDLE, " ").replace(HASHTAG, " ").replace(EMOJI, ""));
  // Captions use " | " as a hard separator between the line and the credits.
  text = (text.split(/\s\|\s/u)[0] ?? text).trim();
  // First sentence: cut at ". " / "! " / "? " or a newline, but not at a
  // trailing ellipsis, and never down to a single word ("Consistency! Be
  // consistent even when…" keeps the whole line rather than one word).
  const sentence = text.match(/^(.+?[.!?])(\s|$)/u);
  if (sentence && sentence[1] && !sentence[1].endsWith("…") && sentence[1].length >= 12 && titleWords(sentence[1]).length >= 2) text = sentence[1];
  text = text.replace(TRAILING_JUNK, "").replace(LEADING_JUNK, "");
  if (text.length > maxLength) {
    const cut = text.slice(0, maxLength);
    text = cut.slice(0, cut.lastIndexOf(" ") > 40 ? cut.lastIndexOf(" ") : maxLength).replace(TRAILING_JUNK, "");
  }
  return text;
}

/**
 * A caption is not a title. Strip links, handles, hashtags, emoji and markup,
 * keep the first sentence, cap the length at a word boundary, and fall back
 * when fewer than two words survive — "@nilstar" and "🗣️we out here" are real
 * rows in the library.
 */
export function cleanTitle(raw: string, fallback: string, maxLength = 120): string {
  const text = titleCandidate(raw, maxLength);
  return titleWords(text).length >= 2 ? text : fallback;
}

/**
 * The keyword list a partner gets (and media:keywords in the feed): the clip's
 * sport, content type and secondary types, its school, the caption keywords,
 * then any hand-set tags. Deduplicated case-insensitively, first spelling
 * wins. `none-visible` and `other` are classifier buckets, not keywords, and
 * are left out here (they stay on the structured fields).
 */
export function partnerTags(row: Item): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (value: unknown): void => {
    if (typeof value !== "string") return;
    const v = value.trim();
    if (!v || v === "none-visible" || v === "other") return;
    const k = v.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    out.push(v);
  };
  add(row["sport"]);
  add(row["contentType"]);
  if (Array.isArray(row["contentTypes"])) for (const t of row["contentTypes"]) add(t);
  add(row["school"]);
  if (Array.isArray(row["keywords"])) for (const k of row["keywords"]) add(k);
  if (Array.isArray(row["tags"])) for (const t of row["tags"]) add(t);
  return out;
}

/** Plain text for a partner's description: no markup, no emoji, hashtags optional. */
export function cleanDescription(raw: string, options: { keepHashtags?: boolean } = {}): string {
  let text = raw.replace(HTML_TAG, " ").replace(EMOJI, "");
  if (!options.keepHashtags) text = text.replace(HASHTAG, " ");
  return collapse(text).replace(TRAILING_JUNK, "");
}

/* ── Signed URL validity ───────────────────────────────────────────────────── */

/**
 * Expiry aligned to a weekly boundary: the Monday 00:00 UTC strictly after
 * `now`, plus seven days. Every URL minted in the same Monday-to-Sunday week
 * carries the same expiry, so a feed rebuilt every fifteen minutes presents
 * byte-identical URLs to a poller (their cache keys on the URL) while every
 * URL still has at least seven days of life when minted.
 */
export function weeklyExpiry(now: Date = new Date()): Date {
  const day = now.getUTCDay(); // 0 = Sunday
  const daysToMonday = ((8 - day) % 7) || 7;
  const monday = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + daysToMonday);
  return new Date(monday + 7 * DAY_MS);
}

/* ── Row → partner asset ───────────────────────────────────────────────────── */

export interface AssetContext {
  row: Item;
  series?: Item;
  channel: Item;
  /** profiles by id, covering athleteId and every featuredAthleteId */
  profilesById: ReadonlyMap<string, Item>;
  partner: Partner;
  /** e.g. https://niltv.com — the watch page every asset links back to */
  canonicalBase: string;
  /** signs a distribution path for the given expiry */
  sign: (path: string, expiresAt: Date) => string;
  expiresAt: Date;
}

const toFile = (ctx: AssetContext, path: string, dims?: { width: number; height: number }): PartnerFile => ({
  url: ctx.sign(path, ctx.expiresAt),
  path,
  type: mimeOf(path),
  ...(dims ?? {}),
  expiresAt: ctx.expiresAt.toISOString(),
});

/**
 * The asset a partner receives. Undefined when the row cannot be represented
 * (no file, no publish date, dangling channel) — a broken row must never 500
 * a feed of five hundred good ones.
 */
export function toPartnerAsset(ctx: AssetContext): PartnerAsset | undefined {
  const { row, series, channel, partner } = ctx;
  const id = String(row["id"] ?? "");
  const paths = resolveSyndicationFiles(row);
  const publishedAt = row["publishedAt"];
  if (!id || !paths || typeof publishedAt !== "string") return undefined;

  const athleteIds: string[] = [];
  const primary = row["athleteId"];
  if (typeof primary === "string") athleteIds.push(primary);
  if (Array.isArray(row["featuredAthleteIds"])) {
    for (const value of row["featuredAthleteIds"] as unknown[]) {
      if (typeof value === "string" && !athleteIds.includes(value)) athleteIds.push(value);
    }
  }
  // Channel pseudo-profiles (p-niltv, p-truebluetv…) hold the credit when no
  // real athlete is on the clip; they are not people and never appear in the
  // partner's athlete list or credit line.
  const athletes = athleteIds
    .filter((athleteId) => !athleteId.startsWith("p-"))
    .map((athleteId) => ctx.profilesById.get(athleteId))
    .filter((profile): profile is Item => profile !== undefined)
    .map((profile) => ({
      id: String(profile["id"]),
      name: String(profile["name"] ?? ""),
      school: String(profile["school"] ?? ""),
      sport: String(profile["sport"] ?? ""),
    }));

  const lead = athletes[0];
  const channelName = String(channel["name"] ?? "");
  const fallbackTitle = lead ? `${lead.name}, ${lead.school}: ${channelName}` : channelName;
  const rights = rightsOf(row, series);
  const seriesId = typeof row["seriesId"] === "string" ? row["seriesId"] : undefined;
  const channelId = String(row["channelId"] ?? "");
  const seriesName = typeof series?.["name"] === "string" ? series["name"] : undefined;

  const platformIds: PlatformId[] = Array.isArray(row["platformIds"])
    ? (row["platformIds"] as PlatformId[])
    : typeof row["sourcePlatform"] === "string" && typeof row["sourcePostId"] === "string"
      ? [
          {
            platform: row["sourcePlatform"],
            id: row["sourcePostId"],
            ...(typeof row["sourceUrl"] === "string" ? { url: row["sourceUrl"] } : {}),
          },
        ]
      : [];

  const category =
    (seriesId && partner.categoryMap[seriesId]) || partner.categoryMap[channelId] || seriesName || channelName;

  const files: PartnerAsset["files"] = { mp4: toFile(ctx, paths.mp4) };
  if (paths.vertical) files.vertical = toFile(ctx, paths.vertical);
  if (paths.source) files.source = toFile(ctx, paths.source);
  if (paths.poster) files.poster = toFile(ctx, paths.poster);
  if (paths.captions) files.captions = toFile(ctx, paths.captions);

  const sport = typeof row["sport"] === "string" ? row["sport"] : undefined;
  const contentType = typeof row["contentType"] === "string" ? row["contentType"] : undefined;
  const school = typeof row["school"] === "string" && row["school"].length > 0 ? row["school"] : undefined;

  return {
    id,
    assetType: assetTypeOf(row),
    series: seriesId && seriesName ? { id: seriesId, name: seriesName } : null,
    channel: { id: channelId, name: channelName },
    title: cleanTitle(String(row["title"] ?? ""), fallbackTitle),
    description: cleanDescription(String(row["description"] ?? row["title"] ?? "")),
    ...(typeof row["duration"] === "number" ? { duration: row["duration"] } : {}),
    publishedAt,
    updatedAt: syndicationUpdatedAtOf(row) ?? publishedAt,
    ...(rights.expiresAt ? { expiresAt: rights.expiresAt } : {}),
    athletes,
    credit:
      rights.creditLine ??
      (athletes.length > 0 ? `${athletes.map((a) => `${a.name}, ${a.school}`).join("; ")} / NIL TV` : "NIL TV"),
    canonicalUrl: `${ctx.canonicalBase}/watch/${id}/`,
    category,
    ...(sport ? { sport } : {}),
    ...(contentType ? { contentType } : {}),
    ...(school ? { school } : {}),
    platformIds,
    tags: partnerTags(row),
    files,
    status: typeof row["withdrawnAt"] === "string" ? "withdrawn" : "published",
  };
}
