import { z } from "zod";
import {
  AssetType,
  ChannelKind,
  ContentProvider,
  ContentType,
  EventStatus,
  Id,
  IsoDate,
  MusicStatus,
  NewsletterSource,
  PartnerStatus,
  ProfileStatus,
  QcState,
  RightsStatus,
  Role,
  SeriesKind,
  SourceKind,
  Sport,
  Surface,
  TranscodeStatus,
} from "./primitives";

/** Account record (design §5: USER#id / META). DOB never leaves the backend. */
export const User = z.object({
  id: Id,
  name: z.string(),
  email: z.string().email(),
  phone: z.string().optional(),
  role: Role.default("fan"),
  is18plus: z.boolean(),
  pushEnabled: z.boolean().default(false),
  createdAt: IsoDate,
});
export type User = z.infer<typeof User>;

/** Content property — TrueBlue TV / NIL TV / Esports. Staff-managed, never a person (spec §5.9). */
export const Channel = z.object({
  id: Id,
  name: z.string(),
  kind: ChannelKind,
  /** brand accent, hex — TrueBlue keeps its blue */
  color: z.string().optional(),
  about: z.string().optional(),
  /**
   * Published clips on the channel, computed by GET /v1/channels (one GSI1
   * COUNT per channel). Absent from fixtures and older servers; clients
   * treat absent as unknown, not zero.
   */
  clipCount: z.number().int().nonnegative().optional(),
  /** the campus node's school, display form ("Duke"); enrichment inherits it when no athlete is credited */
  school: z.string().optional(),
  /** the Instagram account key behind a campus channel (truebluetv) */
  account: z.string().optional(),
});
export type Channel = z.infer<typeof Channel>;

/** Person profile — one entity; ambassador is a status flag (spec §5.9). */
export const Profile = z.object({
  id: Id,
  name: z.string(),
  handle: z.string(),
  school: z.string(),
  sport: z.string(),
  bio: z.string().default(""),
  statuses: z.array(ProfileStatus).default(["athlete"]),
  /** this month's ambassador leaderboard rank, when flagged (post-MVP UI reads it) */
  ambassadorRank: z.number().int().positive().optional(),
  avatarUrl: z.string().optional(),
  coverUrl: z.string().optional(),
  followers: z.number().int().nonnegative().default(0),
  totalViews: z.number().int().nonnegative().default(0),
  socials: z.array(z.object({ platform: z.string(), url: z.string() })).default([]),
  brands: z.array(z.string()).default([]),
  claimedBy: Id.nullable().default(null),
  /* ── Roster sync (content foundation): filled by the dashboard import ── */
  /** our campus node key (dashboard brand_accounts.campus), e.g. "unc" */
  campus: z.string().optional(),
  year: z.string().optional(),
  cohort: z.string().optional(),
  igUserId: z.string().optional(),
  /** dashboard ambassadors.id — the stable identity across handle renames */
  rosterId: z.string().optional(),
  /** dashboard status: candidate | confirmed | removed */
  rosterStatus: z.string().optional(),
  /** handles this person used before (comma list from the dashboard) */
  previousHandles: z.array(z.string()).optional(),
  syncedAt: IsoDate.optional(),
});
export type Profile = z.infer<typeof Profile>;

/**
 * What the source said, verbatim (content foundation). Written once by the
 * adapter that created the row and NEVER edited afterwards: every derived
 * field (title, description, classification) is recomputed from here, so a
 * better rule or a re-run can never lose the original.
 */
export const ContentSource = z.object({
  kind: SourceKind,
  /** our account key for social posts (niltv, truebluetv, chapelhilltv …) */
  account: z.string().optional(),
  /** the original poster's handle (collab posts), lowercased, no @ */
  authorHandle: z.string().optional(),
  postId: z.string().optional(),
  url: z.string().optional(),
  postedAt: IsoDate.optional(),
  /** the caption exactly as posted */
  caption: z.string().optional(),
  mediaType: z.string().optional(),
  /** engagement at last sync — informational, never authoritative */
  metrics: z
    .object({
      views: z.number().int().nonnegative().optional(),
      likes: z.number().int().nonnegative().optional(),
      comments: z.number().int().nonnegative().optional(),
      reach: z.number().int().nonnegative().optional(),
      at: IsoDate,
    })
    .optional(),
  /** where an archive or upload came from (manifest path, Drive folder, YouTube id) */
  reference: z.string().optional(),
});
export type ContentSource = z.infer<typeof ContentSource>;

/** Facts about the file, measured, not declared. */
export const ContentProbe = z.object({
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  bitrateKbps: z.number().int().positive().optional(),
  /** "9:16", "16:9", "1:1" or the reduced ratio */
  aspect: z.string().optional(),
  posterWidth: z.number().int().positive().optional(),
  posterHeight: z.number().int().positive().optional(),
  at: IsoDate,
});
export type ContentProbe = z.infer<typeof ContentProbe>;

/** Per-surface quality verdict — the reasons are the queue. */
export const ContentQc = z.object({
  app: QcState,
  site: QcState,
  partners: QcState,
  youtube: QcState.optional(),
  reasons: z.array(z.string()).default([]),
  at: IsoDate,
});
export type ContentQc = z.infer<typeof ContentQc>;

/**
 * Off-platform rights record on a content row (partner content API). Every
 * field defaults to the conservative value, so an absent record is simply
 * ineligible: nothing leaves the platform until an editor says so.
 * `rightsConfirmed` on the row is a different gate ("fine in our app") and
 * keeps its meaning.
 */
export const ContentRights = z.object({
  status: RightsStatus.default("restricted"),
  /** true only when no school marks appear, or the school's marks are cleared (POLICY#schools) */
  logoCleared: z.boolean().default(false),
  music: MusicStatus.default("unknown"),
  /** earliest syndication instant; absent → publishedAt plus the series delay */
  availableFrom: IsoDate.optional(),
  expiresAt: IsoDate.optional(),
  /** ISO country codes, or WW */
  territory: z.array(z.string()).default(["WW"]),
  /** overrides the computed "{athlete}, {school} / NIL TV" */
  creditLine: z.string().optional(),
});
export type ContentRights = z.infer<typeof ContentRights>;

/** The same asset on another platform. */
export const PlatformId = z.object({
  platform: z.string(),
  id: z.string(),
  url: z.string().optional(),
});
export type PlatformId = z.infer<typeof PlatformId>;

/**
 * Syndication files, as domain-less paths (design §6.8 rule) under the
 * partner download distribution: `/{id}/mezz.mp4` is the video bucket,
 * `/masters/{id}/master.mp4` and `/originals/{id}/master.mp4` are the masters
 * bucket. Absent fields are resolved from the row's playback paths.
 */
export const ContentFiles = z.object({
  mp4Path: z.string().optional(),
  verticalPath: z.string().optional(),
  sourcePath: z.string().optional(),
  posterPath: z.string().optional(),
  captionsPath: z.string().optional(),
  transcriptPath: z.string().optional(),
});
export type ContentFiles = z.infer<typeof ContentFiles>;

/** A video. Belongs to a channel AND credits a creator (spec §5.3 attribution model). */
export const Content = z.object({
  id: Id,
  title: z.string(),
  channelId: Id,
  athleteId: Id,
  description: z.string().default(""),
  provider: ContentProvider.default("hls"),
  /** HLS manifest URL (CloudFront) when provider=hls; embed URL when provider=embed */
  playbackUrl: z.string().optional(),
  thumbUrl: z.string().optional(),
  /** seconds */
  duration: z.number().nonnegative().optional(),
  transcodeStatus: TranscodeStatus.default("uploading"),
  rightsConfirmed: z.boolean().default(false),
  likes: z.number().int().nonnegative().default(0),
  views: z.number().int().nonnegative().default(0),
  publishedAt: IsoDate.optional(),
  /** Set on rows ingested from a social platform (dashboard bridge): where the clip came from. */
  sourcePlatform: z.string().optional(),
  /** Platform-native post id — the ingest dedupe key (content id is derived from it). */
  sourcePostId: z.string().optional(),
  /** Public permalink of the source post. */
  sourceUrl: z.string().optional(),

  /* ── Partner content API (syndication) — all optional, all additive ──── */
  assetType: AssetType.optional(),
  seriesId: Id.optional(),
  /** every athlete on screen; `athleteId` stays the primary credit the app reads */
  featuredAthleteIds: z.array(Id).optional(),
  rights: ContentRights.optional(),
  platformIds: z.array(PlatformId).optional(),
  tags: z.array(z.string()).optional(),
  /** set by the admin withdraw action; the row stays in the syndication index as a tombstone */
  withdrawnAt: IsoDate.optional(),
  withdrawnReason: z.string().optional(),
  /** bumped on substantive edits only — partners re-fetch on it */
  syndicationUpdatedAt: IsoDate.optional(),
  files: ContentFiles.optional(),

  /* ── Content foundation: source, editorial, classification, qc ───────── */
  source: ContentSource.optional(),
  /**
   * Field names a person set by hand (title, description, sport, …). The
   * enrichment pass recomputes every derived field EXCEPT these, so a human
   * decision survives every re-run. Cleared per field from admin.
   */
  overrides: z.array(z.string()).optional(),
  /** one-line editorial summary (partners, SEO); derived, overridable */
  summary: z.string().optional(),
  keywords: z.array(z.string()).optional(),
  sport: Sport.optional(),
  /** the athlete's or account's school, display form ("Duke") */
  school: z.string().optional(),
  contentType: ContentType.optional(),
  /** secondary types, in order */
  contentTypes: z.array(ContentType).optional(),
  /** 0–1 from the classifier; a human override is 1 */
  contentTypeConfidence: z.number().min(0).max(1).optional(),
  sponsor: z.string().optional(),
  season: z.number().int().positive().optional(),
  episode: z.number().int().positive().optional(),
  /** handles seen in the caption or as author that matched no profile — the review queue */
  unresolvedHandles: z.array(z.string()).optional(),
  qc: ContentQc.optional(),
  probe: ContentProbe.optional(),
  /** which surfaces this asset may appear on; absent → app and site (today's behaviour) */
  surfaces: z.array(Surface).optional(),
});
export type Content = z.infer<typeof Content>;

/** A show, podcast or campus programme (SERIES#{id} / META). Rights defaults inherit to its assets. */
export const Series = z.object({
  id: Id,
  name: z.string(),
  kind: SeriesKind.default("show"),
  channelId: Id.optional(),
  about: z.string().optional(),
  coverUrl: z.string().optional(),
  /** applied to an asset whose own rights record leaves a field unset */
  defaultRights: ContentRights.partial().optional(),
  /** days after publish before an asset may syndicate (podcast episodes: 30) */
  syndicationDelayDays: z.number().int().nonnegative().default(0),
  createdAt: IsoDate.optional(),
  updatedAt: IsoDate.optional(),
});
export type Series = z.infer<typeof Series>;

/** What a partner has licensed. Empty series AND channel lists mean nothing is licensed. */
export const PartnerLicence = z.object({
  seriesIds: z.array(Id).default([]),
  /** campus channels licensed outside any series */
  channelIds: z.array(Id).default([]),
  assetTypes: z.array(AssetType).default(["episode", "clip", "short"]),
  territory: z.array(z.string()).default(["WW"]),
  termStart: IsoDate.optional(),
  termEnd: IsoDate.optional(),
  attribution: z.string().optional(),
});
export type PartnerLicence = z.infer<typeof PartnerLicence>;

/**
 * A licensing partner (PARTNER#{id} / META). Key material never lives on this
 * entity: API keys are hashed into PARTNERKEY#{hash} rows, the webhook secret
 * is a row attribute the schema strips, and the feed token is a capability
 * URL component rather than a secret.
 */
export const Partner = z.object({
  id: Id,
  name: z.string(),
  contact: z.string().email().optional(),
  status: PartnerStatus.default("active"),
  licence: PartnerLicence.default({}),
  feedToken: z.string().optional(),
  webhookUrl: z.string().url().optional(),
  webhookEnabled: z.boolean().default(false),
  ipAllowlist: z.array(z.string()).default([]),
  /** our series/channel id → the partner's category label */
  categoryMap: z.record(z.string()).default({}),
  /** first 12 characters of the live key, for support conversations */
  keyPrefix: z.string().optional(),
  keyRotatedAt: IsoDate.optional(),
  createdAt: IsoDate,
  updatedAt: IsoDate.optional(),
});
export type Partner = z.infer<typeof Partner>;

export const EventEntity = z.object({
  id: Id,
  type: z.string().default("vote"),
  title: z.string(),
  status: EventStatus,
  startsAt: IsoDate,
  endsAt: IsoDate,
  prize: z.string().optional(),
  partners: z.array(z.string()).default([]),
  /** short line for cards, e.g. "$10,000 grand prize · 10 finalists" */
  blurb: z.string().optional(),
  /**
   * The event's dated arc (entries open, finalists named, voting, winner).
   * Upcoming events render it as a milestone list where the finalist grid
   * would sit; ended events feed it to the recap's episode rail.
   */
  milestones: z
    .array(z.object({ date: z.string(), label: z.string() }))
    .optional(),
  /**
   * Submissions phase (stage 1 of the event arc).
   * While `entriesCloseAt` is in the future and `submitUrl` is set, an
   * upcoming event renders as SUBMISSIONS OPEN with a submit CTA instead of
   * the plain voting countdown. Both absent → no submissions render.
   */
  submitUrl: z.string().url().optional(),
  entriesCloseAt: IsoDate.optional(),
  /**
   * Submissions-page content (event lifecycle stage 1), mirrored from
   * the event's web page: the About facts, the required-steps checklist,
   * and the contestant FAQ. All optional — sections render only when set.
   */
  about: z
    .object({
      title: z.string(),
      note: z.string().optional(),
      facts: z.array(z.string()),
    })
    .optional(),
  checklist: z.array(z.object({ title: z.string(), copy: z.string() })).optional(),
  faq: z.array(z.object({ q: z.string(), a: z.string() })).optional(),
  /** The Legal Notice to Contestants — linked from every event surface. */
  legalUrl: z.string().url().optional(),
  /**
   * The event's intro reel (its own promo cut, mirrored to the media bucket).
   * Stored as a path, composed per stage (design §6.8); without it the app
   * falls back to the network sizzle.
   */
  introVideoPath: z.string().optional(),
  introVideoUrl: z.string().optional(),
  /**
   * Site-mirrored season recap (display-only; niltv.com is the source of
   * truth). When present, the recap render uses this instead of the
   * entries-based leaderboard — finalists here are NOT profile records.
   *
   * Media follows the same rule as content rows (design §6.8): stored rows
   * carry domain-less `*Path` values under the media bucket, and event-detail
   * composes the absolute `*Url` from PLAYBACK_BASE_URL at request time, so
   * the data is not welded to one stage's CloudFront domain. The `*Url` fields
   * stay writable for embeds that genuinely live off-CDN.
   */
  showcase: z
    .object({
      heading: z.string(),
      winner: z.object({
        name: z.string(),
        school: z.string(),
        sport: z.string(),
        videoPath: z.string().optional(),
        posterPath: z.string().optional(),
        videoUrl: z.string().optional(),
        posterUrl: z.string().optional(),
        /** The announcement post (Instagram permalink) — the recap's outbound link. */
        postUrl: z.string().url().optional(),
      }),
      finalists: z.array(
        z.object({
          name: z.string(),
          school: z.string(),
          sport: z.string(),
          photoPath: z.string().optional(),
          photoUrl: z.string().optional(),
          /** The audition reel (mirrored) — the recap grid is tap-to-play. */
          videoPath: z.string().optional(),
          videoUrl: z.string().optional(),
        }),
      ),
    })
    .optional(),
});
export type EventEntity = z.infer<typeof EventEntity>;

/** Finalist in an event. */
export const Entry = z.object({
  id: Id,
  eventId: Id,
  athleteId: Id,
  auditionContentId: Id.optional(),
  votes: z.number().int().nonnegative().default(0),
});
export type Entry = z.infer<typeof Entry>;

/** Newsletter subscriber (SUB#{email} / META) — the system of record (design §6.7). */
export const Subscriber = z.object({
  email: z.string().email(),
  phone: z.string().optional(),
  /** every entry point this email signed up from, first one first */
  sources: z.array(NewsletterSource).min(1),
  createdAt: IsoDate,
  updatedAt: IsoDate.optional(),
  /** double opt-in: false until the confirm link is clicked */
  confirmed: z.boolean().default(false),
  confirmedAt: IsoDate.optional(),
});
export type Subscriber = z.infer<typeof Subscriber>;

/** Remote-config item (CONFIG#app / META) — the ops panel (design §9). */
export const AppConfig = z.object({
  activeEventId: Id.nullable().default(null),
  flags: z
    .object({
      liveSegment: z.boolean().default(false),
      ambassadorDirectory: z.boolean().default(false),
    })
    .default({}),
  minAppVersion: z.string().default("0.1.0"),
});
export type AppConfig = z.infer<typeof AppConfig>;
