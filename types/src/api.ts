import { z } from "zod";
import {
  AppConfig,
  Channel,
  Content,
  ContentRights,
  Entry,
  EventEntity,
  Partner,
  PartnerLicence,
  PlatformId,
  Profile,
  Series,
  Subscriber,
} from "./entities";
import {
  AssetType,
  ContentProvider,
  ContentType,
  EventStatus,
  Id,
  IsoDate,
  NewsletterSource,
  NotifTargetType,
  PartnerStatus,
  ProfileStatus,
  Role,
  SeriesKind,
  Sport,
  TranscodeStatus,
  VoteErrorCode,
  VoteSource,
} from "./primitives";

/* ── Cards (what lists/rails carry — deliberately smaller than entities) ───────── */

export const ContentCard = z.object({
  id: Id,
  title: z.string(),
  channelId: Id,
  channelName: z.string(),
  creatorId: Id,
  creatorName: z.string(),
  creatorIsAmbassador: z.boolean(),
  thumbUrl: z.string().optional(),
  duration: z.number().nonnegative().optional(),
  publishedAt: IsoDate.optional(),
});
export type ContentCard = z.infer<typeof ContentCard>;

export const AthleteChip = z.object({
  id: Id,
  name: z.string(),
  school: z.string(),
  sport: z.string(),
  avatarUrl: z.string().optional(),
  isAmbassador: z.boolean(),
  ambassadorRank: z.number().int().positive().optional(),
});
export type AthleteChip = z.infer<typeof AthleteChip>;

export const EventCard = z.object({
  id: Id,
  title: z.string(),
  status: EventStatus,
  startsAt: IsoDate,
  endsAt: IsoDate,
  prize: z.string().optional(),
  blurb: z.string().optional(),
  /** Submissions phase (spec stage 1) — hub + Home render SUBMISSIONS OPEN with a submit CTA while the deadline is ahead. */
  submitUrl: z.string().url().optional(),
  entriesCloseAt: IsoDate.optional(),
  /** Billboard media, composed server-side (§6.8): the event's intro reel and its showcase key art. */
  introVideoUrl: z.string().optional(),
  heroImageUrl: z.string().optional(),
  /** The season champion (from the showcase) — recap slides headline the name, dev-site style. */
  winnerName: z.string().optional(),
});
export type EventCard = z.infer<typeof EventCard>;

/* ── GET /v1/config ────────────────────────────────────────────────────────────── */

export const ConfigResponse = AppConfig.extend({
  apiVersion: z.string(),
  serverTime: IsoDate,
});
export type ConfigResponse = z.infer<typeof ConfigResponse>;

/* ── GET /v1/home (one composed, cacheable object per screen — design §4.1) ────── */

export const HomeHero = z.discriminatedUnion("state", [
  z.object({ state: z.literal("live"), event: EventCard }),
  z.object({ state: z.literal("upcoming"), event: EventCard }),
  z.object({ state: z.literal("recap"), event: EventCard }),
  z.object({ state: z.literal("none") }),
]);
export type HomeHero = z.infer<typeof HomeHero>;

export const Rail = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("content"),
    key: z.string(),
    title: z.string(),
    items: z.array(ContentCard),
  }),
  z.object({
    kind: z.literal("athletes"),
    key: z.string(),
    title: z.string(),
    items: z.array(AthleteChip),
  }),
]);
export type Rail = z.infer<typeof Rail>;

export const HomeResponse = z.object({
  hero: HomeHero,
  rails: z.array(Rail),
});
export type HomeResponse = z.infer<typeof HomeResponse>;

/* ── GET /v1/events · GET /v1/events/{id} ──────────────────────────────────────── */

export const EventsListResponse = z.object({
  events: z.array(EventCard),
});
export type EventsListResponse = z.infer<typeof EventsListResponse>;

export const EntryDetail = z.object({
  id: Id,
  athleteId: Id,
  name: z.string(),
  school: z.string(),
  sport: z.string(),
  bio: z.string(),
  avatarUrl: z.string().optional(),
  auditionContentId: Id.optional(),
  votes: z.number().int().nonnegative(),
});
export type EntryDetail = z.infer<typeof EntryDetail>;

/** Frozen at event end by the transition Lambda — recap never recomputes (design §6.5). */
export const EventRecap = z.object({
  championEntryId: Id,
  leaderboard: z.array(z.object({ entryId: Id, rank: z.number().int().positive(), votes: z.number().int() })),
  totals: z.object({
    votes: z.number().int(),
    entries: z.number().int(),
    daysLive: z.number().int(),
  }),
});
export type EventRecap = z.infer<typeof EventRecap>;

export const EventDetailResponse = z.object({
  event: EventEntity,
  /** server-rotated order for bias-free display (spec §5.4) */
  entries: z.array(EntryDetail),
  recap: EventRecap.optional(),
});
export type EventDetailResponse = z.infer<typeof EventDetailResponse>;

/* ── GET /v1/channels · GET /v1/content ────────────────────────────────────────── */

export const ChannelsResponse = z.object({ channels: z.array(Channel) });
export type ChannelsResponse = z.infer<typeof ChannelsResponse>;

export const ContentListResponse = z.object({
  items: z.array(ContentCard),
  cursor: z.string().optional(),
});
export type ContentListResponse = z.infer<typeof ContentListResponse>;

export const ContentDetailResponse = z.object({
  id: Id,
  title: z.string(),
  description: z.string(),
  channelId: Id,
  channelName: z.string(),
  provider: ContentProvider,
  playbackUrl: z.string(),
  thumbUrl: z.string().optional(),
  duration: z.number().nonnegative().optional(),
  likes: z.number().int().nonnegative(),
  creator: AthleteChip,
  related: z.array(ContentCard),
});
export type ContentDetailResponse = z.infer<typeof ContentDetailResponse>;

/* ── GET /v1/profiles/{id} ─────────────────────────────────────────────────────── */

export const ProfileResponse = z.object({
  id: Id,
  name: z.string(),
  handle: z.string(),
  school: z.string(),
  sport: z.string(),
  bio: z.string(),
  statuses: z.array(ProfileStatus),
  ambassadorRank: z.number().int().positive().optional(),
  avatarUrl: z.string().optional(),
  coverUrl: z.string().optional(),
  stats: z.object({
    followers: z.number().int(),
    views: z.number().int(),
    nilstarVotes: z.number().int(),
  }),
  socials: z.array(z.object({ platform: z.string(), url: z.string() })),
  brands: z.array(z.string()),
  content: z.array(ContentCard),
});
export type ProfileResponse = z.infer<typeof ProfileResponse>;

/* ── Authenticated: /v1/me — profile + everything gated UI needs in one call ───── */

export const NotificationFollow = z.object({
  targetType: NotifTargetType,
  targetId: Id,
});
export type NotificationFollow = z.infer<typeof NotificationFollow>;

export const MeResponse = z.object({
  userId: Id,
  name: z.string(),
  email: z.string(),
  role: Role,
  is18plus: z.boolean(),
  pushEnabled: z.boolean(),
  /** eventId → entryId the user voted for */
  votes: z.record(z.string(), z.string()),
  follows: z.array(Id),
  /** contentIds the user has liked — the client derives per-clip liked state from this */
  likes: z.array(Id).default([]),
  notificationFollows: z.array(NotificationFollow),
});
export type MeResponse = z.infer<typeof MeResponse>;

/* ── POST /v1/events/{id}/vote (design §6.3) ───────────────────────────────────── */

export const VoteRequest = z.object({ entryId: Id });
export type VoteRequest = z.infer<typeof VoteRequest>;

export const VoteResponse = z.object({
  status: z.literal("ok"),
  eventId: Id,
  entryId: Id,
});
export type VoteResponse = z.infer<typeof VoteResponse>;

export const VoteError = z.object({
  error: VoteErrorCode,
  message: z.string().optional(),
});
export type VoteError = z.infer<typeof VoteError>;

/** Generic write ack — idempotent endpoints return it even when already in the target state. */
export const AckResponse = z.object({ status: z.literal("ok") });
export type AckResponse = z.infer<typeof AckResponse>;

/** Ack for follow/unfollow (idempotent — returned even when already in the target state). */
export const FollowAckResponse = AckResponse;
export type FollowAckResponse = z.infer<typeof FollowAckResponse>;

/**
 * Ack for like/unlike, plus the clip's current likes counter. The client writes
 * it straight into its detail cache: the public detail read is edge-cached for
 * 60 s, so a refetch would hand back a stale count. Optional on the wire: an
 * older server answers a bare ack, and the server itself leaves it out
 * when the counter read-back fails after the write. The client keeps its
 * optimistic count either way.
 */
export const LikeAckResponse = FollowAckResponse.extend({
  likes: z.number().int().nonnegative().optional(),
});
export type LikeAckResponse = z.infer<typeof LikeAckResponse>;

/* ── Misc writes ───────────────────────────────────────────────────────────────── */

export const NewsletterRequest = z.object({
  /** normalized in the contract so SUB#{email} keys are canonical (design §6.7) */
  email: z.string().trim().toLowerCase().email(),
  phone: z.string().trim().max(40).optional(),
  source: NewsletterSource,
});
export type NewsletterRequest = z.infer<typeof NewsletterRequest>;

export const NotificationFollowsPutRequest = z.object({
  follows: z.array(NotificationFollow).max(200),
});
export type NotificationFollowsPutRequest = z.infer<typeof NotificationFollowsPutRequest>;

export const DeviceRegisterRequest = z.object({
  expoPushToken: z.string().min(1),
  platform: z.enum(["ios", "android"]),
});
export type DeviceRegisterRequest = z.infer<typeof DeviceRegisterRequest>;

/** PUT /v1/me/push — the Profile global push toggle (design §7: checked at fanout). */
export const PushToggleRequest = z.object({ enabled: z.boolean() });
export type PushToggleRequest = z.infer<typeof PushToggleRequest>;

/** Per-event payload ceiling: telemetry is anonymous, so an unbounded props
 *  bag would let one caller write multi-megabyte S3 objects per call. */
export const TELEMETRY_PROPS_MAX_BYTES = 4096;
export const TelemetryEvent = z.object({
  type: z.string().min(1).max(64),
  ts: IsoDate,
  props: z
    .record(z.string(), z.unknown())
    .default({})
    .refine((p) => JSON.stringify(p).length <= TELEMETRY_PROPS_MAX_BYTES, {
      message: `props must serialize to <= ${TELEMETRY_PROPS_MAX_BYTES} bytes`,
    }),
});
export type TelemetryEvent = z.infer<typeof TelemetryEvent>;

export const TelemetryBatchRequest = z.object({
  events: z.array(TelemetryEvent).max(100),
});
export type TelemetryBatchRequest = z.infer<typeof TelemetryBatchRequest>;

/* ── Admin (staff-only API — separate HTTP API, JWT + `staff` Cognito group) ───── */

export const AdminContentUpsertRequest = z.object({
  /** absent → create (server assigns the id) */
  id: Id.optional(),
  title: z.string().min(1),
  channelId: Id,
  athleteId: Id,
  description: z.string().default(""),
  rightsConfirmed: z.boolean().default(false),
  /* ── syndication tagging (partner content API); absent → untouched ──── */
  assetType: AssetType.optional(),
  seriesId: Id.nullable().optional(),
  featuredAthleteIds: z.array(Id).optional(),
  rights: ContentRights.partial().optional(),
  platformIds: z.array(PlatformId).optional(),
  tags: z.array(z.string()).optional(),
  /* ── classification + editorial (content foundation); every field a staff
   *    member sends is recorded as an override and survives re-enrichment ── */
  summary: z.string().optional(),
  keywords: z.array(z.string()).optional(),
  sport: Sport.nullable().optional(),
  school: z.string().nullable().optional(),
  contentType: ContentType.nullable().optional(),
  contentTypes: z.array(ContentType).optional(),
  sponsor: z.string().nullable().optional(),
  season: z.number().int().positive().nullable().optional(),
  episode: z.number().int().positive().nullable().optional(),
  /** field names to hand back to the enrichment pass (clear the override) */
  clearOverrides: z.array(z.string()).optional(),
});
export type AdminContentUpsertRequest = z.infer<typeof AdminContentUpsertRequest>;

/** POST /admin/content/{id}/withdraw — pulls an asset from every partner surface. */
export const AdminContentWithdrawRequest = z.object({
  reason: z.string().min(1),
});
export type AdminContentWithdrawRequest = z.infer<typeof AdminContentWithdrawRequest>;

export const AdminContentWithdrawResponse = z.object({
  status: z.enum(["withdrawn", "restored"]),
  at: IsoDate,
});
export type AdminContentWithdrawResponse = z.infer<typeof AdminContentWithdrawResponse>;

/* ── Admin: series and partners (partner content API) ─────────────────────── */

export const AdminSeriesUpsertRequest = z.object({
  /** absent → create (server derives the id from the name) */
  id: Id.optional(),
  name: z.string().min(1),
  kind: SeriesKind.optional(),
  channelId: Id.optional(),
  about: z.string().optional(),
  coverUrl: z.string().optional(),
  defaultRights: ContentRights.partial().optional(),
  syndicationDelayDays: z.number().int().nonnegative().optional(),
});
export type AdminSeriesUpsertRequest = z.infer<typeof AdminSeriesUpsertRequest>;

export const AdminSeriesListResponse = z.object({ series: z.array(Series) });
export type AdminSeriesListResponse = z.infer<typeof AdminSeriesListResponse>;

export const AdminPartnerUpsertRequest = z.object({
  /** absent → create (server derives the id from the name and issues a key) */
  id: Id.optional(),
  name: z.string().min(1),
  contact: z.string().email().optional(),
  status: PartnerStatus.optional(),
  licence: PartnerLicence.partial().optional(),
  webhookUrl: z.string().url().nullable().optional(),
  webhookEnabled: z.boolean().optional(),
  ipAllowlist: z.array(z.string()).optional(),
  categoryMap: z.record(z.string()).optional(),
});
export type AdminPartnerUpsertRequest = z.infer<typeof AdminPartnerUpsertRequest>;

export const AdminPartnerListResponse = z.object({ partners: z.array(Partner) });
export type AdminPartnerListResponse = z.infer<typeof AdminPartnerListResponse>;

/** Create returns the plain key exactly once; it is stored hashed and never shown again. */
export const AdminPartnerCreatedResponse = z.object({
  partner: Partner,
  apiKey: z.string(),
  webhookSecret: z.string(),
});
export type AdminPartnerCreatedResponse = z.infer<typeof AdminPartnerCreatedResponse>;

/** POST /admin/partners/{id}/rotate-key · /revoke-key */
export const AdminPartnerKeyResponse = z.object({
  status: z.enum(["rotated", "revoked"]),
  apiKey: z.string().optional(),
  keyPrefix: z.string().optional(),
  /** the previous key keeps working until this instant (rotate only) */
  previousKeyExpiresAt: IsoDate.optional(),
});
export type AdminPartnerKeyResponse = z.infer<typeof AdminPartnerKeyResponse>;

export const AdminContentListResponse = z.object({
  items: z.array(Content),
  cursor: z.string().optional(),
});
export type AdminContentListResponse = z.infer<typeof AdminContentListResponse>;

/** Presigned single-part PUT for the video master (multipart comes later if files outgrow it). */
export const AdminUploadUrlResponse = z.object({
  uploadUrl: z.string(),
  key: z.string(),
  expiresInSeconds: z.number().int().positive(),
});
export type AdminUploadUrlResponse = z.infer<typeof AdminUploadUrlResponse>;

export const AdminPublishResponse = z.object({
  status: z.literal("published"),
  publishedAt: IsoDate,
});
export type AdminPublishResponse = z.infer<typeof AdminPublishResponse>;

/** Transcode progress for the admin drawer's status poll. */
export const AdminContentStatusResponse = z.object({
  transcodeStatus: TranscodeStatus,
  transcodeError: z.string().optional(),
  playbackPath: z.string().optional(),
  durationSec: z.number().nonnegative().optional(),
});
export type AdminContentStatusResponse = z.infer<typeof AdminContentStatusResponse>;

export const AdminProfileUpsertRequest = z.object({
  id: Id.optional(),
  name: z.string().min(1),
  handle: z.string().min(1),
  school: z.string(),
  sport: z.string(),
  bio: z.string().optional(),
  statuses: z.array(ProfileStatus).optional(),
  ambassadorRank: z.number().int().positive().optional(),
  socials: z.array(z.object({ platform: z.string(), url: z.string() })).optional(),
  brands: z.array(z.string()).optional(),
});
export type AdminProfileUpsertRequest = z.infer<typeof AdminProfileUpsertRequest>;

export const AdminProfileListResponse = z.object({ items: z.array(Profile) });
export type AdminProfileListResponse = z.infer<typeof AdminProfileListResponse>;

/** GET /admin/newsletter — subscriber list (staff export; ?format=csv returns text/csv instead). */
export const AdminSubscriberListResponse = z.object({ items: z.array(Subscriber) });
export type AdminSubscriberListResponse = z.infer<typeof AdminSubscriberListResponse>;

/* ── Admin: events & voting (design §6.3/§6.5) ─────────────────────────────────── */

export const AdminEventUpsertRequest = z.object({
  /** absent → create (server assigns the id) */
  id: Id.optional(),
  title: z.string().min(1),
  type: z.string().default("vote"),
  startsAt: IsoDate,
  endsAt: IsoDate,
  prize: z.string().optional(),
  partners: z.array(z.string()).default([]),
  blurb: z.string().optional(),
});
export type AdminEventUpsertRequest = z.infer<typeof AdminEventUpsertRequest>;

export const AdminEventListResponse = z.object({ items: z.array(EventEntity) });
export type AdminEventListResponse = z.infer<typeof AdminEventListResponse>;

export const AdminEventDetailResponse = z.object({
  event: EventEntity,
  entries: z.array(Entry),
});
export type AdminEventDetailResponse = z.infer<typeof AdminEventDetailResponse>;

export const AdminEntryUpsertRequest = z.object({
  /** absent → create (server assigns the id) */
  id: Id.optional(),
  athleteId: Id,
  auditionContentId: Id.optional(),
});
export type AdminEntryUpsertRequest = z.infer<typeof AdminEntryUpsertRequest>;

/** Manual status override — the break-glass path around the scheduled transitions (§6.5). */
export const AdminEventStatusRequest = z.object({ status: EventStatus });
export type AdminEventStatusRequest = z.infer<typeof AdminEventStatusRequest>;

/**
 * Vote audit export (design §6.3: facts are the source of truth, counters are
 * display). `tallies` recomputes each entry's count from
 * the Vote fact rows and compares it to the display counter.
 */
export const AdminEventAuditResponse = z.object({
  eventId: Id,
  generatedAt: IsoDate,
  totalVotes: z.number().int().nonnegative(),
  /** true only when every entry's recomputed fact count equals its counter */
  countersMatch: z.boolean(),
  tallies: z.array(
    z.object({
      entryId: Id,
      counter: z.number().int(),
      factCount: z.number().int(),
      matches: z.boolean(),
    }),
  ),
  votes: z.array(
    z.object({
      entryId: Id,
      userId: Id,
      createdAt: IsoDate,
      source: VoteSource,
    }),
  ),
});
export type AdminEventAuditResponse = z.infer<typeof AdminEventAuditResponse>;
