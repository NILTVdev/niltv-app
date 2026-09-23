/**
 * GET /partner/v1/content — the partner's catalogue, newest first, paged.
 *
 * Query params: limit (1–100, default 50), cursor, series, channel, athlete,
 * school, sport, assetType, publishedSince, updatedSince (ISO). The GSI3
 * partition holds every syndication candidate; the partner scope, the time
 * windows and the filters are applied here, so a page can come back short
 * with a cursor that continues — never padded, never re-queried in a loop
 * past a bounded number of index pages.
 */
import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { type PartnerAsset, PartnerAssetListResponse } from "@niltv/types";
import type { APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { GSI3, SYND_ALL_GSI3PK, getDocClient } from "../../lib/db";
import { badRequest, forbidden, json, unauthorized } from "../../lib/http";
import { requireOriginVerify } from "../../lib/origin";
import { encodeCursor, type Item } from "../../lib/shape";
import { decodeSyndicationCursor } from "../../lib/syndication-index";
import { buildAssets, loadLookups } from "./catalogue";
import { isSyndicable } from "../../lib/syndication";
import { canonicalBase, loadPartner, partnerApiDisabled, partnerApiEnabled, partnerIdOf, type PartnerEvent } from "./context";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
/** Index pages walked per request before returning a short page with a cursor. */
const MAX_INDEX_PAGES = 4;

interface Filters {
  series?: string;
  channel?: string;
  athlete?: string;
  school?: string;
  sport?: string;
  assetType?: string;
  publishedSince?: string;
  updatedSince?: string;
}

const isoOrUndefined = (value: string | undefined): string | undefined | null => {
  if (value === undefined) return undefined;
  return Number.isNaN(Date.parse(value)) ? null : new Date(value).toISOString();
};

function rowMatches(row: Item, f: Filters): boolean {
  if (f.series && row["seriesId"] !== f.series) return false;
  if (f.channel && row["channelId"] !== f.channel) return false;
  if (f.assetType && (row["assetType"] ?? "clip") !== f.assetType) return false;
  if (f.athlete) {
    const featured = Array.isArray(row["featuredAthleteIds"]) ? (row["featuredAthleteIds"] as unknown[]) : [];
    if (row["athleteId"] !== f.athlete && !featured.includes(f.athlete)) return false;
  }
  if (f.publishedSince && String(row["publishedAt"] ?? "") < f.publishedSince) return false;
  return true;
}

// school/sport match the clip's own classification or any credited athlete's
// roster values, case-insensitively, so ?sport=lacrosse finds both a clip
// tagged "lacrosse" and one credited to a "Women's Lacrosse" athlete. Decided
// on the row before any asset is built: building an asset signs its URLs,
// so filtering after the build can run a sparse filter into the Lambda timeout.
const eq = (a: unknown, b: string): boolean => typeof a === "string" && a.toLowerCase() === b.toLowerCase();
const has = (a: unknown, b: string): boolean => typeof a === "string" && a.toLowerCase().includes(b.toLowerCase());
function classificationMatches(row: Item, profiles: Map<string, Item>, f: Filters): boolean {
  if (!f.school && !f.sport) return true;
  const ids = [row["athleteId"], ...(Array.isArray(row["featuredAthleteIds"]) ? (row["featuredAthleteIds"] as unknown[]) : [])];
  const athletes = ids.filter((id): id is string => typeof id === "string" && !id.startsWith("p-")).map((id) => profiles.get(id)).filter((p): p is Item => p !== undefined);
  if (f.school && !eq(row["school"], f.school) && !athletes.some((a) => eq(a["school"], f.school!))) return false;
  if (f.sport && !eq(row["sport"], f.sport) && !athletes.some((a) => eq(a["sport"], f.sport!) || has(a["sport"], f.sport!))) return false;
  return true;
}

export const handler = async (event: PartnerEvent): Promise<APIGatewayProxyStructuredResultV2> => {
  if (!partnerApiEnabled()) return partnerApiDisabled();
  if (!requireOriginVerify(event)) return forbidden();
  const partnerId = partnerIdOf(event);
  if (!partnerId) return unauthorized();
  const partner = await loadPartner(partnerId);
  if (!partner) return unauthorized();

  const q = event.queryStringParameters ?? {};
  const limitRaw = q["limit"] !== undefined ? Number(q["limit"]) : DEFAULT_LIMIT;
  if (!Number.isInteger(limitRaw) || limitRaw < 1 || limitRaw > MAX_LIMIT) {
    return badRequest(`limit must be an integer between 1 and ${MAX_LIMIT}`);
  }
  const publishedSince = isoOrUndefined(q["publishedSince"]);
  const updatedSince = isoOrUndefined(q["updatedSince"]);
  if (publishedSince === null || updatedSince === null) return badRequest("publishedSince/updatedSince must be ISO-8601");
  const filters: Filters = {
    ...(q["series"] ? { series: q["series"] } : {}),
    ...(q["channel"] ? { channel: q["channel"] } : {}),
    ...(q["athlete"] ? { athlete: q["athlete"] } : {}),
    ...(q["school"] ? { school: q["school"] } : {}),
    ...(q["sport"] ? { sport: q["sport"] } : {}),
    ...(q["assetType"] ? { assetType: q["assetType"] } : {}),
    ...(publishedSince ? { publishedSince } : {}),
    ...(updatedSince ? { updatedSince } : {}),
  };
  const startKey = q["cursor"] !== undefined ? decodeSyndicationCursor(q["cursor"]) : undefined;
  if (q["cursor"] !== undefined && startKey === undefined) return badRequest("cursor is not valid");

  const db = getDocClient();
  const table = process.env.TABLE_NAME ?? "";
  const now = new Date();
  const items: PartnerAsset[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined = startKey;
  let lastKey: Record<string, unknown> | undefined;

  for (let page = 0; page < MAX_INDEX_PAGES && items.length < limitRaw; page += 1) {
    let out;
    try {
      out = await db.send(
        new QueryCommand({
          TableName: table,
          IndexName: GSI3,
          KeyConditionExpression: updatedSince ? "GSI3PK = :pk AND GSI3SK >= :since" : "GSI3PK = :pk",
          ExpressionAttributeValues: { ":pk": SYND_ALL_GSI3PK, ...(updatedSince ? { ":since": updatedSince } : {}) },
          ScanIndexForward: false,
          Limit: MAX_LIMIT,
          ExclusiveStartKey: exclusiveStartKey,
        }),
      );
    } catch (err) {
      // Well-formed but wrong for this index (another stage, a key-schema
      // change): the caller's bad cursor, not a server fault.
      if (exclusiveStartKey && (err as { name?: string }).name === "ValidationException") return badRequest("cursor is not a valid page cursor");
      throw err;
    }
    const candidates = ((out.Items ?? []) as Item[]).filter((row) => rowMatches(row, filters));
    const lookups = await loadLookups(candidates);
    // Everything that decides membership is settled on the row (scope, rights,
    // classification) before an asset is built, because building one signs
    // its URLs. Only as many rows as the page still needs are built.
    const eligible = candidates.filter((row) => {
      const series = typeof row["seriesId"] === "string" ? lookups.seriesById.get(row["seriesId"]) : undefined;
      return isSyndicable(row, series, partner, now).eligible && classificationMatches(row, lookups.profilesById, filters);
    });
    const needed = limitRaw - items.length;
    const take = eligible.slice(0, needed);
    const assets = take.length > 0 ? await buildAssets(take, { partner, canonicalBase: canonicalBase(), now, lookups }) : [];
    items.push(...assets);
    lastKey = out.LastEvaluatedKey as Record<string, unknown> | undefined;
    if (eligible.length > needed) {
      // The page had more than we handed back: the cursor points at the last
      // row returned, not the page boundary, so nothing on this page is skipped.
      const last = take[take.length - 1]!;
      lastKey = { PK: last["PK"], SK: last["SK"], GSI3PK: last["GSI3PK"], GSI3SK: last["GSI3SK"] };
      break;
    }
    exclusiveStartKey = lastKey;
    if (!lastKey) break;
  }

  // A cursor is only meaningful when the index has more; a page that ended
  // exactly on the limit still hands back the key so the partner can ask.
  return json(
    200,
    PartnerAssetListResponse.parse({ items, ...(lastKey ? { cursor: encodeCursor(lastKey) } : {}) }),
    "private, max-age=60",
  );
};
