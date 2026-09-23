/**
 * Partner content API contract (`/partner/v1/*`) — what a licensing partner
 * receives when it pulls our catalogue. Mirrors the Media RSS feed item for
 * item; both are produced by the same mapper in the backend, so a field added
 * here is a field added to the feed.
 *
 * Every media URL is a signed, expiring CloudFront URL on the partner download
 * distribution. Expiry is aligned to a weekly boundary so the URL a poller
 * sees is byte-identical between feed rebuilds (their cache keys on it).
 */
import { z } from "zod";
import { PartnerLicence, PlatformId } from "./entities";
import { AssetType, Id, IsoDate, PartnerEventType, PartnerStatus } from "./primitives";

/** One downloadable file. `path` is the distribution path the URL was signed for. */
export const PartnerFile = z.object({
  url: z.string(),
  path: z.string(),
  /** MIME type, e.g. video/mp4, image/jpeg, text/vtt */
  type: z.string(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  bytes: z.number().int().nonnegative().optional(),
  expiresAt: IsoDate,
});
export type PartnerFile = z.infer<typeof PartnerFile>;

export const PartnerAthlete = z.object({
  id: Id,
  name: z.string(),
  school: z.string(),
  sport: z.string(),
});
export type PartnerAthlete = z.infer<typeof PartnerAthlete>;

/** One asset as a partner sees it. `status: withdrawn` only ever appears in /changes. */
export const PartnerAsset = z.object({
  id: Id,
  assetType: AssetType,
  series: z.object({ id: Id, name: z.string() }).nullable(),
  channel: z.object({ id: Id, name: z.string() }),
  title: z.string(),
  description: z.string(),
  /** seconds */
  duration: z.number().nonnegative().optional(),
  publishedAt: IsoDate,
  updatedAt: IsoDate,
  expiresAt: IsoDate.optional(),
  athletes: z.array(PartnerAthlete),
  credit: z.string(),
  /** the niltv.com watch page — the attribution link every partner shows */
  canonicalUrl: z.string(),
  /** partner-side category from the partner's own map, else our series/channel name */
  category: z.string(),
  /** the clip's own classification (content foundation vocabularies), absent when the pass could not decide */
  sport: z.string().optional(),
  contentType: z.string().optional(),
  school: z.string().optional(),
  platformIds: z.array(PlatformId),
  /** keyword list built from sport, content type, school and caption keywords; feeds media:keywords */
  tags: z.array(z.string()),
  files: z.object({
    mp4: PartnerFile,
    vertical: PartnerFile.optional(),
    /** the untouched upload or archived original, when it differs from mp4 */
    source: PartnerFile.optional(),
    poster: PartnerFile.optional(),
    captions: PartnerFile.optional(),
  }),
  status: z.enum(["published", "withdrawn"]),
});
export type PartnerAsset = z.infer<typeof PartnerAsset>;

/* ── GET /partner/v1/me ──────────────────────────────────────────────────── */

export const PartnerMeResponse = z.object({
  partner: z.object({ id: Id, name: z.string(), status: PartnerStatus }),
  licence: PartnerLicence,
  feeds: z
    .object({
      mrss: z.string(),
      json: z.string(),
    })
    .optional(),
  /** how long a signed media URL stays valid, so pollers can size their cache */
  urlValiditySeconds: z.number().int().positive(),
});
export type PartnerMeResponse = z.infer<typeof PartnerMeResponse>;

/* ── GET /partner/v1/series · /channels ─────────────────────────────────── */

export const PartnerSeriesResponse = z.object({
  series: z.array(
    z.object({
      id: Id,
      name: z.string(),
      kind: z.string(),
      about: z.string().optional(),
      coverUrl: z.string().optional(),
    }),
  ),
});
export type PartnerSeriesResponse = z.infer<typeof PartnerSeriesResponse>;

export const PartnerChannelsResponse = z.object({
  channels: z.array(z.object({ id: Id, name: z.string(), kind: z.string(), about: z.string().optional() })),
});
export type PartnerChannelsResponse = z.infer<typeof PartnerChannelsResponse>;

/* ── GET /partner/v1/content ────────────────────────────────────────────── */

export const PartnerAssetListResponse = z.object({
  items: z.array(PartnerAsset),
  cursor: z.string().optional(),
});
export type PartnerAssetListResponse = z.infer<typeof PartnerAssetListResponse>;

/* ── GET /partner/v1/changes?since= ─────────────────────────────────────── */

export const PartnerChange = z.object({
  id: Id,
  type: PartnerEventType,
  at: IsoDate,
});
export type PartnerChange = z.infer<typeof PartnerChange>;

export const PartnerChangesResponse = z.object({
  since: IsoDate,
  changes: z.array(PartnerChange),
  cursor: z.string().optional(),
});
export type PartnerChangesResponse = z.infer<typeof PartnerChangesResponse>;

/* ── Webhook payload ─────────────────────────────────────────────────────── */

/**
 * What a partner's endpoint receives. Deliberately small: an id, a type and
 * a version. The partner calls the API for the rest, so retries and
 * duplicates are harmless and the payload never carries stale state.
 * Signed with `x-niltv-signature: sha256=<hmac>` over the raw body.
 */
export const PartnerWebhookEvent = z.object({
  eventId: z.string(),
  type: PartnerEventType,
  contentId: Id,
  updatedAt: IsoDate,
  sentAt: IsoDate,
});
export type PartnerWebhookEvent = z.infer<typeof PartnerWebhookEvent>;
