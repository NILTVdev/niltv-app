/**
 * Pure item-shaping for the read handlers (conventions: handlers stay thin —
 * selection, ordering and mapping live here, unit-testable without an AWS
 * client). Raw DynamoDB items go in, contract shapes from @niltv/types come
 * out; zod `.parse` strips table keys and validates on the way through.
 */
import {
  AthleteChip,
  ContentCard,
  EntryDetail,
  EventCard,
  type HomeHero,
  MeResponse,
  NotificationFollow,
} from "@niltv/types";
import { FOLLOW_SK_PREFIX, LIKE_SK_PREFIX, NOTIF_SK_PREFIX, VOTE_SK_PREFIX } from "./db";

/** Loose DynamoDB item — required attributes are enforced by zod at the edges. */
export type Item = Record<string, unknown>;

/* ── Playback URL composition (design §6.8) ───────────────────────────────── */

/**
 * Rows written by the transcode pipeline carry domain-less paths
 * (playbackPath/thumbPath) so the media stack never depends on the edge
 * stack; read handlers compose absolute URLs from PLAYBACK_BASE_URL at
 * request time. Rows with a stored absolute URL (fixtures, embeds) pass
 * through untouched.
 */
function resolveMediaUrl(row: Item, urlAttr: string, pathAttr: string): string | undefined {
  const url = row[urlAttr];
  if (typeof url === "string" && url.length > 0) return url;
  const base = process.env.PLAYBACK_BASE_URL;
  const path = row[pathAttr];
  if (base && typeof path === "string" && path.length > 0) return `${base}${path}`;
  return undefined;
}

/** Absolute HLS/embed URL for a content row; undefined → the row is not playable. */
export const resolvePlaybackUrl = (row: Item): string | undefined =>
  resolveMediaUrl(row, "playbackUrl", "playbackPath");

/** Absolute poster URL for a content row; undefined when no thumb exists yet. */
export const resolveThumbUrl = (row: Item): string | undefined =>
  resolveMediaUrl(row, "thumbUrl", "thumbPath");

/**
 * Path→URL composition for an event's mirrored media (design §6.8): the
 * intro reel on the row itself, plus — when a season showcase exists — the
 * winner reel and each finalist's still + audition. Rows without media pass
 * through untouched.
 */
export function resolveEventMedia(row: Item): Item {
  const base: Item =
    row["introVideoPath"] !== undefined || row["introVideoUrl"] !== undefined
      ? { ...row, introVideoUrl: resolveMediaUrl(row, "introVideoUrl", "introVideoPath") }
      : row;

  const showcase = row["showcase"];
  if (typeof showcase !== "object" || showcase === null || Array.isArray(showcase)) return base;
  const value = showcase as Record<string, unknown>;

  const winner = (value["winner"] ?? {}) as Item;
  const finalists = Array.isArray(value["finalists"]) ? (value["finalists"] as Item[]) : [];

  return {
    ...base,
    // Top-level card fields (EventCard): the champion's hero frame doubles as
    // the season's poster, and recap slides headline the champion's name.
    heroImageUrl: resolveMediaUrl(winner, "posterUrl", "posterPath"),
    ...(typeof winner["name"] === "string" ? { winnerName: winner["name"] } : {}),
    showcase: {
      ...value,
      winner: {
        ...winner,
        videoUrl: resolveMediaUrl(winner, "videoUrl", "videoPath"),
        posterUrl: resolveMediaUrl(winner, "posterUrl", "posterPath"),
      },
      finalists: finalists.map((finalist) => ({
        ...finalist,
        photoUrl: resolveMediaUrl(finalist, "photoUrl", "photoPath"),
        videoUrl: resolveMediaUrl(finalist, "videoUrl", "videoPath"),
      })),
    },
  };
}

/* ── Pagination cursors ───────────────────────────────────────────────────── */

/** Opaque list cursor: base64url-encoded JSON of the DynamoDB LastEvaluatedKey. */
export function encodeCursor(lastEvaluatedKey: Record<string, unknown> | undefined): string | undefined {
  if (!lastEvaluatedKey) return undefined;
  return Buffer.from(JSON.stringify(lastEvaluatedKey), "utf8").toString("base64url");
}

/** Inverse of encodeCursor. Undefined for a missing OR malformed cursor — callers that received a cursor string treat undefined as a client error. */
export function decodeCursor(cursor: string | undefined): Record<string, unknown> | undefined {
  if (!cursor) return undefined;
  try {
    const decoded: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    return typeof decoded === "object" && decoded !== null && !Array.isArray(decoded)
      ? (decoded as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** EventCard from a raw event item (PK/SK/GSI attributes stripped by zod). */
export const toEventCard = (item: Item): EventCard => EventCard.parse(item);

/**
 * Hero-state selection (design §6.1): a live/upcoming active event is the
 * hero; an ended (or missing) active event falls back to the most recently
 * ended event as a recap; no events at all → none.
 */
export function selectHero(activeEventId: string | null, events: Item[]): HomeHero {
  const active = activeEventId ? events.find((e) => e["id"] === activeEventId) : undefined;
  if (active) {
    const status = active["status"];
    if (status === "live") return { state: "live", event: toEventCard(active) };
    if (status === "upcoming") return { state: "upcoming", event: toEventCard(active) };
  }
  const latestEnded = events
    .filter((e) => e["status"] === "ended")
    .sort((a, b) => String(b["endsAt"]).localeCompare(String(a["endsAt"])))[0];
  if (latestEnded) return { state: "recap", event: toEventCard(latestEnded) };
  return { state: "none" };
}

const STATUS_ORDER: Record<string, number> = { live: 0, upcoming: 1, ended: 2 };

/**
 * Events-tab ordering (design §4.1): live first, then upcoming soonest-first,
 * then ended most-recently-ended-first.
 */
export function sortEvents(events: Item[]): Item[] {
  return [...events].sort((a, b) => {
    const groupA = STATUS_ORDER[String(a["status"])] ?? 3;
    const groupB = STATUS_ORDER[String(b["status"])] ?? 3;
    if (groupA !== groupB) return groupA - groupB;
    if (groupA === STATUS_ORDER["ended"]) {
      return String(b["endsAt"]).localeCompare(String(a["endsAt"]));
    }
    return String(a["startsAt"]).localeCompare(String(b["startsAt"]));
  });
}

/**
 * Bias-free display rotation (design §4.1, spec §5.4): rotate the array by
 * `minuteOfHour % length`, so no entry permanently owns the top slot while
 * every viewer within the same minute (and CloudFront cache window) sees the
 * same order.
 */
export function rotateByMinute<T>(items: readonly T[], minuteOfHour: number): T[] {
  if (items.length === 0) return [];
  const offset = ((minuteOfHour % items.length) + items.length) % items.length;
  return [...items.slice(offset), ...items.slice(0, offset)];
}

const hasAmbassadorStatus = (item: Item): boolean =>
  Array.isArray(item["statuses"]) && (item["statuses"] as unknown[]).includes("ambassador");

const rankOf = (item: Item): number =>
  typeof item["ambassadorRank"] === "number" ? item["ambassadorRank"] : Number.MAX_SAFE_INTEGER;

/** AthleteChip from a raw profile item (ambassador derived from the status flags). */
export const toAthleteChip = (item: Item): AthleteChip =>
  AthleteChip.parse({ ...item, isAmbassador: hasAmbassadorStatus(item) });

/**
 * Featured Ambassadors rail: keep profiles whose statuses include
 * `ambassador`, order by ambassadorRank ascending (unranked last), cap at 10.
 */
export function ambassadorChips(profiles: Item[]): AthleteChip[] {
  return profiles
    .filter(hasAmbassadorStatus)
    .sort((a, b) => rankOf(a) - rankOf(b))
    .slice(0, 10)
    .map(toAthleteChip);
}

/**
 * Directory chips for GET /v1/profiles (design §4.1, dark until
 * flags.ambassadorDirectory): every profile in stored GSI order, or — with
 * the ambassador filter — only ambassador-status profiles re-sorted by rank
 * ascending, unranked last (stable, so equal ranks keep GSI order).
 */
export function directoryChips(profiles: Item[], ambassadorsOnly: boolean): AthleteChip[] {
  const kept = ambassadorsOnly ? profiles.filter(hasAmbassadorStatus).sort((a, b) => rankOf(a) - rankOf(b)) : profiles;
  return kept.map(toAthleteChip);
}

/**
 * ContentCard from a raw content item plus its channel/creator lookups
 * (spec §5.3 attribution: a clip belongs to a channel AND credits a creator).
 * Undefined when a lookup is missing — one broken card must never 500 a rail.
 */
export function toContentCard(
  item: Item,
  channelsById: ReadonlyMap<string, Item>,
  profilesById: ReadonlyMap<string, Item>,
): ContentCard | undefined {
  const channel = channelsById.get(String(item["channelId"]));
  const creator = profilesById.get(String(item["athleteId"]));
  if (!channel || !creator) return undefined;
  return ContentCard.parse({
    ...item,
    channelName: channel["name"],
    creatorId: creator["id"],
    creatorName: creator["name"],
    creatorIsAmbassador: hasAmbassadorStatus(creator),
  });
}

/**
 * EntryDetail from an ENTRY row plus its athlete profile — identity and bio
 * come from the profile, votes from the entry. Undefined when the profile is
 * missing (defensive: a dangling athleteId must not 500 the event screen).
 */
export function toEntryDetail(entry: Item, profilesById: ReadonlyMap<string, Item>): EntryDetail | undefined {
  const profile = profilesById.get(String(entry["athleteId"]));
  if (!profile) return undefined;
  return EntryDetail.parse({
    id: entry["id"],
    athleteId: entry["athleteId"],
    name: profile["name"],
    school: profile["school"],
    sport: profile["sport"],
    bio: profile["bio"] ?? "",
    avatarUrl: profile["avatarUrl"],
    auditionContentId: entry["auditionContentId"],
    votes: entry["votes"] ?? 0,
  });
}

/**
 * /v1/me partition mapping (design §5 row kinds): split a full USER#{id}
 * query into identity fields (META row), follows, votes, likes and
 * notification follows. Undefined when the META row is absent (deleted
 * account with a still-valid JWT).
 */
export function mapUserPartition(userId: string, rows: Item[]): MeResponse | undefined {
  const meta = rows.find((r) => r["SK"] === "META");
  if (!meta) return undefined;

  const follows: string[] = [];
  const likes: string[] = [];
  const votes: Record<string, string> = {};
  const notificationFollows: NotificationFollow[] = [];

  for (const row of rows) {
    const sk = String(row["SK"]);
    if (sk.startsWith(FOLLOW_SK_PREFIX)) {
      follows.push(sk.slice(FOLLOW_SK_PREFIX.length));
    } else if (sk.startsWith(LIKE_SK_PREFIX)) {
      likes.push(sk.slice(LIKE_SK_PREFIX.length));
    } else if (sk.startsWith(VOTE_SK_PREFIX)) {
      const entryId = row["entryId"];
      if (typeof entryId === "string") votes[sk.slice(VOTE_SK_PREFIX.length)] = entryId;
    } else if (sk.startsWith(NOTIF_SK_PREFIX)) {
      const [targetType, ...targetIdParts] = sk.slice(NOTIF_SK_PREFIX.length).split("#");
      const parsed = NotificationFollow.safeParse({ targetType, targetId: targetIdParts.join("#") });
      if (parsed.success) notificationFollows.push(parsed.data);
    }
  }

  return MeResponse.parse({
    userId,
    name: meta["name"],
    email: meta["email"],
    role: meta["role"],
    is18plus: meta["is18plus"] === true,
    pushEnabled: meta["pushEnabled"] === true,
    votes,
    follows,
    likes,
    notificationFollows,
  });
}
