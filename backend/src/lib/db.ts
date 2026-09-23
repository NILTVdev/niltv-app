/**
 * Data layer: DocumentClient singleton + key builders for the single-table
 * schema (design §5). Handlers never assemble PK/SK strings themselves.
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

let documentClient: DynamoDBDocumentClient | undefined;

/** Lazily-created DocumentClient shared across warm Lambda invocations. */
export function getDocClient(): DynamoDBDocumentClient {
  if (!documentClient) {
    documentClient = DynamoDBDocumentClient.from(
      new DynamoDBClient({ region: process.env.AWS_REGION ?? "us-east-1" }),
      { marshallOptions: { removeUndefinedValues: true } },
    );
  }
  return documentClient;
}

export interface TableKey {
  PK: string;
  SK: string;
}

/** CONFIG#app / META — the remote-config "ops panel" item (design §9). */
export const configKey = (): TableKey => ({ PK: "CONFIG#app", SK: "META" });

/** USER#{id} / META — account record. */
export const userKey = (id: string): TableKey => ({ PK: `USER#${id}`, SK: "META" });

/** ATHLETE#{id} / META — person profile (ambassador is a status flag, spec §5.9). */
export const profileKey = (id: string): TableKey => ({ PK: `ATHLETE#${id}`, SK: "META" });

/** EVENT#{id} / META — competition event. */
export const eventKey = (id: string): TableKey => ({ PK: `EVENT#${id}`, SK: "META" });

/** EVENT#{eventId} / ENTRY#{entryId} — finalist row within an event. */
export const entryKey = (eventId: string, entryId: string): TableKey => ({
  PK: `EVENT#${eventId}`,
  SK: `ENTRY#${entryId}`,
});

/** CHANNEL#{id} / META — content property (TrueBlue TV / NIL TV / Esports). */
export const channelKey = (id: string): TableKey => ({ PK: `CHANNEL#${id}`, SK: "META" });

/** CONTENT#{id} / META — a clip. */
export const contentKey = (id: string): TableKey => ({ PK: `CONTENT#${id}`, SK: "META" });

/** Shape of a content tombstone — see `contentTombstone`. */
export interface ContentTombstone extends TableKey {
  id: string;
  removed: true;
  removedAt: string;
  removedReason: string;
}

/**
 * CONTENT#{id} / META tombstone — what "removing" a clip writes in place of
 * the row. A tombstone is a CONTENT row with no entity fields, no
 * publishedAt and no GSI keys, so it is invisible to every public read
 * (content-list/home/profile rails query the sparse GSIs; content-detail 404s
 * rows without publishedAt) and to the admin library scan (it filters on
 * `removed`), but it satisfies the ingest bridge's existence check, so a post
 * the dashboard keeps serving is never mirrored again. A DeleteCommand leaves
 * the bridge nothing to find, so the next ingest run mirrors the post back.
 *
 * Rule: never DeleteCommand a content row; tombstone it
 * (scripts/remove-content-item.ts).
 */
export const contentTombstone = (
  id: string,
  reason: string,
  removedAt: string = new Date().toISOString(),
): ContentTombstone => ({
  ...contentKey(id),
  id,
  removed: true,
  removedAt,
  removedReason: reason,
});

/** SERIES#{id} / META — a show, podcast or campus programme (partner content API). */
export const seriesKey = (id: string): TableKey => ({ PK: `SERIES#${id}`, SK: "META" });

/** PARTNER#{id} / META — a licensing partner (partner content API). */
export const partnerKey = (id: string): TableKey => ({ PK: `PARTNER#${id}`, SK: "META" });

/**
 * PARTNERKEY#{hash} / META — an API key, stored only as the salted SHA-256 of
 * the plain key. Lookup is a GetItem on the hash of the presented key, so a
 * table dump never yields a usable credential and rotation is a second row.
 */
export const partnerApiKeyKey = (hash: string): TableKey => ({ PK: `PARTNERKEY#${hash}`, SK: "META" });

/** PARTNER#{partnerId} / WEBHOOK#{sentAt}#{eventId} — one webhook delivery attempt (the partner's delivery log). */
export const webhookLogKey = (partnerId: string, sentAt: string, eventId: string): TableKey => ({
  PK: `PARTNER#${partnerId}`,
  SK: `${WEBHOOK_SK_PREFIX}${sentAt}#${eventId}`,
});

/**
 * POLICY#schools / META — which schools' marks are cleared for syndication
 * (content foundation). `{ blockedSchools: [] }` is an opt-out list: a
 * school's marks count as cleared unless it is listed. Read by enrichment to
 * seed rights.logoCleared; edited by staff, never by a pipeline.
 */
export const schoolPolicyKey = (): TableKey => ({ PK: "POLICY#schools", SK: "META" });

/** SUB#{email} / META — newsletter subscriber (system of record, design §6.7). */
export const subscriberKey = (email: string): TableKey => ({ PK: `SUB#${email}`, SK: "META" });

/** NLTOKEN#{token} / META — one-time newsletter confirm token → email (double opt-in). */
export const newsletterTokenKey = (token: string): TableKey => ({ PK: `NLTOKEN#${token}`, SK: "META" });

/** USER#{userId} / FOLLOW#{athleteId} — follow fact row (design §5). */
export const followKey = (userId: string, athleteId: string): TableKey => ({
  PK: `USER#${userId}`,
  SK: `FOLLOW#${athleteId}`,
});

/** USER#{userId} / LIKE#{contentId} — like fact row (design §5: count lives on the content item). */
export const likeKey = (userId: string, contentId: string): TableKey => ({
  PK: `USER#${userId}`,
  SK: `LIKE#${contentId}`,
});

/** USER#{userId} / VOTE#{eventId} — vote fact row; key uniqueness IS the 1-vote/account/event rule (design §6.3). */
export const voteKey = (userId: string, eventId: string): TableKey => ({
  PK: `USER#${userId}`,
  SK: `VOTE#${eventId}`,
});

/** USER#{userId} / DEVICE#{expoPushToken} — push device registration (design §6.4). */
export const deviceKey = (userId: string, expoPushToken: string): TableKey => ({
  PK: `USER#${userId}`,
  SK: `DEVICE#${expoPushToken}`,
});

/** USER#{userId} / NOTIF#{targetType}#{targetId} — ★-picker opt-in fact row (design §7). */
export const notifFollowKey = (
  userId: string,
  targetType: string,
  targetId: string,
): TableKey => ({
  PK: `USER#${userId}`,
  SK: `${NOTIF_SK_PREFIX}${targetType}#${targetId}`,
});

/** GSI1 mirror of a vote row — EVENT#{eventId} / VOTE#{entryId}#{userId} (tally audit & export, design §5). */
export const voteGsi = (
  eventId: string,
  entryId: string,
  userId: string,
): { GSI1PK: string; GSI1SK: string } => ({
  GSI1PK: `EVENT#${eventId}`,
  GSI1SK: `VOTE#${entryId}#${userId}`,
});

/** GSI1 keys of an event META row — EVENTS#ALL / {status}#{startsAt} (design §5: the Events-tab partition). */
export const eventGsi = (status: string, startsAt: string): { GSI1PK: string; GSI1SK: string } => ({
  GSI1PK: EVENTS_ALL_GSI1PK,
  GSI1SK: `${status}#${startsAt}`,
});

/** GSI1 mirror of a follow row — ATHLETE#{athleteId} / USER#{userId} (follower lookups, design §5). */
export const followGsi = (userId: string, athleteId: string): { GSI1PK: string; GSI1SK: string } => ({
  GSI1PK: `ATHLETE#${athleteId}`,
  GSI1SK: `USER#${userId}`,
});

/** GSI1 mirror of a notif-follow row — TARGET#{type}#{id} / USER#{userId}. This partition IS the topic system (design §7). */
export const notifFollowGsi = (
  userId: string,
  targetType: string,
  targetId: string,
): { GSI1PK: string; GSI1SK: string } => ({
  GSI1PK: notifTargetGsi1Pk(targetType, targetId),
  GSI1SK: `USER#${userId}`,
});

/** GSI1 mirror of a device row — DEVICES#ALL / USER#{userId}#{token} (broadcast partition, design §7). */
export const deviceGsi = (
  userId: string,
  expoPushToken: string,
): { GSI1PK: string; GSI1SK: string } => ({
  GSI1PK: DEVICES_ALL_GSI1PK,
  GSI1SK: `USER#${userId}#${expoPushToken}`,
});

/** GSI1 mirror of a subscriber row — SUBS#ALL / {createdAt}#{email} (staff export scan-free, design §6.7). */
export const subscriberGsi = (
  createdAt: string,
  email: string,
): { GSI1PK: string; GSI1SK: string } => ({
  GSI1PK: SUBS_ALL_GSI1PK,
  GSI1SK: `${createdAt}#${email}`,
});

/* ── Prefixes (handlers never spell these strings themselves) ─────────────── */

/** SK prefix of follow rows inside a USER#{id} partition. */
export const FOLLOW_SK_PREFIX = "FOLLOW#";

/** SK prefix of vote rows inside a USER#{id} partition (row carries `entryId`). */
export const VOTE_SK_PREFIX = "VOTE#";

/** SK prefix of notification-follow rows: NOTIF#{targetType}#{targetId}. */
export const NOTIF_SK_PREFIX = "NOTIF#";

/** SK prefix of like rows inside a USER#{id} partition. */
export const LIKE_SK_PREFIX = "LIKE#";

/** SK prefix of device rows inside a USER#{id} partition. */
export const DEVICE_SK_PREFIX = "DEVICE#";

/** SK prefix of finalist rows inside an EVENT#{id} partition. */
export const ENTRY_SK_PREFIX = "ENTRY#";

/** PK prefix of channel items — used to split mixed BatchGet responses. */
export const CHANNEL_PK_PREFIX = "CHANNEL#";

/** PK prefix of person-profile items — used to split mixed BatchGet responses. */
export const ATHLETE_PK_PREFIX = "ATHLETE#";

/** SK prefix of webhook delivery-log rows inside a PARTNER#{id} partition. */
export const WEBHOOK_SK_PREFIX = "WEBHOOK#";

/** PK prefix of series items — used to split mixed BatchGet responses. */
export const SERIES_PK_PREFIX = "SERIES#";

/** PK prefix of partner items. */
export const PARTNER_PK_PREFIX = "PARTNER#";

/* ── GSI1 (design §5) ─────────────────────────────────────────────────────── */

/** Index name of the first GSI on the single table. */
export const GSI1 = "GSI1";

/** GSI1 partition holding every event; GSI1SK is `{status}#{startsAt}`. */
export const EVENTS_ALL_GSI1PK = "EVENTS#ALL";

/** GSI1 partition holding every person profile; GSI1SK is rank-or-name. */
export const PROFILES_ALL_GSI1PK = "PROFILES#ALL";

/** GSI1 partition holding every registered push device; GSI1SK is USER#{userId}#{token}. */
export const DEVICES_ALL_GSI1PK = "DEVICES#ALL";

/** GSI1 partition holding every newsletter subscriber; GSI1SK is {createdAt}#{email}. */
export const SUBS_ALL_GSI1PK = "SUBS#ALL";

/** GSI1 partition of a notification target's opt-ins — TARGET#{type}#{id} (design §6.4 fanout query). */
export const notifTargetGsi1Pk = (targetType: string, targetId: string): string =>
  `TARGET#${targetType}#${targetId}`;

/**
 * PK of the anonymized replacement for a deleted user's vote rows (design
 * §6.6: votes are anonymized, never deleted, so contest tallies stay intact).
 * The hash is deterministic so a retried purge lands on the same key.
 */
export const deletedUserPk = (hash: string): string => `USER#deleted#${hash}`;

/** GSI1 partition of a channel's published clips; GSI1SK is `{publishedAt}`. */
export const channelContentGsi1Pk = (channelId: string): string => `CHANNEL#${channelId}`;

/**
 * GSI1/GSI2 partition of an athlete's mirrored rows: entry runs + follower
 * mirrors live on GSI1 (`ENTRY#{eventId}` / `USER#{userId}` sort keys), their
 * published clips on GSI2 (`{publishedAt}` sort key) — design §5.
 */
export const athleteGsiPk = (athleteId: string): string => `ATHLETE#${athleteId}`;

/** GSI1 partition holding every series; GSI1SK is the display name. */
export const SERIES_ALL_GSI1PK = "SERIES#ALL";

/** GSI1 partition holding every partner; GSI1SK is the display name. */
export const PARTNERS_ALL_GSI1PK = "PARTNERS#ALL";

/* ── GSI2 (design §5: creator attribution → profile Content tab) ──────────── */

/** Index name of the second GSI on the single table. */
export const GSI2 = "GSI2";

/* ── GSI3 (partner content API: the syndication index) ───────────────────── */

/** Index name of the third GSI on the single table. */
export const GSI3 = "GSI3";

/**
 * GSI3 partition holding every syndication candidate — a content row that
 * has been published with a rights record whose status is owned or licensed.
 * GSI3SK is `{syndicationUpdatedAt}#{id}`, so partners page newest-first and
 * /changes?since= is a range query. Withdrawn rows KEEP their key: they are
 * the tombstones a partner polls for. Partner-specific scope and the time
 * windows are applied by the handler after the query.
 */
export const SYND_ALL_GSI3PK = "SYND#ALL";

/** GSI3 keys of a syndication candidate — see SYND_ALL_GSI3PK. */
export const syndicationGsi = (
  syndicationUpdatedAt: string,
  contentId: string,
): { GSI3PK: string; GSI3SK: string } => ({
  GSI3PK: SYND_ALL_GSI3PK,
  GSI3SK: `${syndicationUpdatedAt}#${contentId}`,
});

/* ── Shared error predicates ──────────────────────────────────────────────── */

/**
 * True when a TransactWrite was cancelled only by its condition check —
 * the idempotent-repeat signal for follow/like writes (design §5 counters).
 */
export function isConditionalCheckFailed(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const cancelled = err as { name?: string; CancellationReasons?: Array<{ Code?: string }> };
  return (
    cancelled.name === "TransactionCanceledException" &&
    (cancelled.CancellationReasons ?? []).some((reason) => reason.Code === "ConditionalCheckFailed")
  );
}

/**
 * True when a TransactWrite was cancelled by a concurrent transaction on the
 * same item (hot counter under burst) — the transaction did NOT commit, so a
 * bounded retry is safe and correct.
 */
export function isTransactionConflict(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const cancelled = err as { name?: string; CancellationReasons?: Array<{ Code?: string }> };
  return (
    cancelled.name === "TransactionCanceledException" &&
    (cancelled.CancellationReasons ?? []).some((reason) => reason.Code === "TransactionConflict") &&
    !(cancelled.CancellationReasons ?? []).some((reason) => reason.Code === "ConditionalCheckFailed")
  );
}

/**
 * Full-jitter exponential backoff for TransactWrite retries.
 *
 * Under a burst of concurrent votes on a few entries, a short fixed retry lets
 * TransactionConflicts on an entry's vote counter exhaust every attempt and
 * surface as HTTP 500s, including on a voter's first tap.
 *
 * Full jitter (random across the whole window, not a fixed delay plus noise) is
 * what actually de-clusters a burst: fixed backoff re-collides the same
 * contenders on every round.
 */
export function backoffDelayMs(
  attempt: number,
  baseMs = 25,
  capMs = 800,
  random: () => number = Math.random,
): number {
  const ceiling = Math.min(capMs, baseMs * 2 ** attempt);
  return random() * ceiling;
}

/** Retry budget for the vote transaction — ~1.5 s worst case, well inside the API timeout. */
export const VOTE_TRANSACTION_ATTEMPTS = 6;
