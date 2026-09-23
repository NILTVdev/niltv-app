import { z } from "zod";

/** Opaque string ids — ULIDs in practice, but the contract only requires non-empty strings. */
export const Id = z.string().min(1);
export type Id = z.infer<typeof Id>;

/** ISO-8601 timestamp (UTC). */
export const IsoDate = z.string().datetime({ offset: true });
export type IsoDate = z.infer<typeof IsoDate>;

export const Role = z.enum(["fan", "athlete", "brand", "ambassador"]);
export type Role = z.infer<typeof Role>;

/** Status flags layered on a person profile — ambassador is a flag, not a type (spec §5.9). */
export const ProfileStatus = z.enum(["athlete", "ambassador"]);
export type ProfileStatus = z.infer<typeof ProfileStatus>;

export const EventStatus = z.enum(["upcoming", "live", "ended"]);
export type EventStatus = z.infer<typeof EventStatus>;

export const ChannelKind = z.enum(["trueblue", "niltv", "esports", "campus"]);
export type ChannelKind = z.infer<typeof ChannelKind>;

/** How a clip plays: self-hosted HLS (default) or an external embed (legacy/live escape hatch). */
export const ContentProvider = z.enum(["hls", "embed"]);
export type ContentProvider = z.infer<typeof ContentProvider>;

export const TranscodeStatus = z.enum(["uploading", "processing", "ready", "published", "failed"]);
export type TranscodeStatus = z.infer<typeof TranscodeStatus>;

export const NotifTargetType = z.enum(["channel", "ambassador", "school", "event"]);
export type NotifTargetType = z.infer<typeof NotifTargetType>;

export const NewsletterSource = z.enum(["topbar", "home_band", "profile", "post_vote", "recap"]);
export type NewsletterSource = z.infer<typeof NewsletterSource>;

export const VoteSource = z.enum(["app", "web"]);
export type VoteSource = z.infer<typeof VoteSource>;

/** Typed error codes the vote endpoint returns (design §6.3). */
export const VoteErrorCode = z.enum(["AGE_GATE", "WINDOW_CLOSED", "ALREADY_VOTED", "INVALID_ENTRY"]);
export type VoteErrorCode = z.infer<typeof VoteErrorCode>;

/** Standard API error envelope. */
export const ApiError = z.object({
  error: z.string(),
  message: z.string().optional(),
});
export type ApiError = z.infer<typeof ApiError>;

/* ── Partner content API (syndication) ───────────────────────────────────── */

/** Syndication asset class: a full episode, a clip, or a vertical short. */
export const AssetType = z.enum(["episode", "clip", "short"]);
export type AssetType = z.infer<typeof AssetType>;

/**
 * Who holds the off-platform right: `owned` (original series), `licensed`
 * (used under a licence), `restricted` (internal only).
 * Absent on a row means restricted.
 */
export const RightsStatus = z.enum(["owned", "licensed", "restricted"]);
export type RightsStatus = z.infer<typeof RightsStatus>;

/**
 * Audio clearance for off-platform use. `platform` is social-library audio,
 * licensed for that platform only — it never syndicates. `unknown` is the
 * default for ingested reels until an editor reviews them.
 */
export const MusicStatus = z.enum(["none", "cleared", "platform", "unknown"]);
export type MusicStatus = z.infer<typeof MusicStatus>;

export const SeriesKind = z.enum(["show", "podcast", "campus"]);
export type SeriesKind = z.infer<typeof SeriesKind>;

export const PartnerStatus = z.enum(["active", "suspended"]);
export type PartnerStatus = z.infer<typeof PartnerStatus>;

/** Lifecycle events a partner can subscribe to (webhook + /changes). */
export const PartnerEventType = z.enum(["content.published", "content.updated", "content.withdrawn"]);
export type PartnerEventType = z.infer<typeof PartnerEventType>;

/* ── Content foundation (ingest tagging) ─────────────────────────────────── */

/** Where an asset came from. Set once by the adapter that created the row; never edited. */
export const SourceKind = z.enum(["instagram-owned", "instagram-collab", "archive", "upload", "youtube"]);
export type SourceKind = z.infer<typeof SourceKind>;

/**
 * Sport vocabulary. Seeded from the content taxonomy sheet
 * plus the roster's sports. `none-visible` is a real label: a clip with no
 * sport on screen (a skit, a vlog) and must not be confused with "unknown".
 */
export const Sport = z.enum([
  "baseball", "basketball", "cheer-dance", "cross-country", "esports", "fencing", "field-hockey", "football",
  "golf", "gymnastics", "ice-hockey", "lacrosse", "multi-sport", "rowing", "soccer", "softball", "swim-dive",
  "tennis", "track-field", "ultimate-frisbee", "volleyball", "wrestling", "none-visible",
]);
export type Sport = z.infer<typeof Sport>;

/** Content type vocabulary — the taxonomy sheet's `type_primary` values, unchanged so its rows load as-is. */
export const ContentType = z.enum([
  "hype-announcement", "training-workout", "skit-humor", "singing-audition", "interview-podcast", "ditl-vlog",
  "celebration-highlight", "team-qa", "brand-sponsored", "what-i-eat", "travel-road", "gear-haul", "game-day",
  "media-day", "grwm-fitcheck", "recovery", "micd-up", "bts", "other",
]);
export type ContentType = z.infer<typeof ContentType>;

/** Per-surface quality state. `ready` means every rule for that surface passes. */
export const QcState = z.enum(["ready", "needs-tagging", "needs-rights", "needs-review"]);
export type QcState = z.infer<typeof QcState>;

/** The surfaces an asset can be published to; each has its own eligibility rule. */
export const Surface = z.enum(["app", "site", "partners", "youtube"]);
export type Surface = z.infer<typeof Surface>;
