/**
 * Row → PartnerAsset for a batch of syndication candidates: one BatchGet for
 * every series, channel and athlete the batch references, one signer, one
 * weekly expiry. Shared by the list/detail handlers and the feed builder
 * (which loads lookups once and maps the same rows for every partner).
 */
import { BatchGetCommand } from "@aws-sdk/lib-dynamodb";
import type { Partner, PartnerAsset } from "@niltv/types";
import {
  ATHLETE_PK_PREFIX,
  CHANNEL_PK_PREFIX,
  SERIES_PK_PREFIX,
  channelKey,
  getDocClient,
  profileKey,
  seriesKey,
  type TableKey,
} from "../../lib/db";
import { getPartnerSigner, type PartnerSigner } from "../../lib/partner-signing";
import type { Item } from "../../lib/shape";
import { isSyndicable, toPartnerAsset, weeklyExpiry } from "../../lib/syndication";

const BATCH_GET_MAX = 100;

export interface Lookups {
  seriesById: Map<string, Item>;
  channelsById: Map<string, Item>;
  profilesById: Map<string, Item>;
}

const str = (value: unknown): string | undefined => (typeof value === "string" && value.length > 0 ? value : undefined);

/** Every series/channel/profile key a batch of rows references, deduplicated. */
export function lookupKeysFor(rows: readonly Item[]): TableKey[] {
  const keys = new Map<string, TableKey>();
  const add = (key: TableKey) => keys.set(`${key.PK}/${key.SK}`, key);
  for (const row of rows) {
    const seriesId = str(row["seriesId"]);
    if (seriesId) add(seriesKey(seriesId));
    const channelId = str(row["channelId"]);
    if (channelId) add(channelKey(channelId));
    const athleteId = str(row["athleteId"]);
    if (athleteId) add(profileKey(athleteId));
    if (Array.isArray(row["featuredAthleteIds"])) {
      for (const id of row["featuredAthleteIds"] as unknown[]) {
        const value = str(id);
        if (value) add(profileKey(value));
      }
    }
  }
  return [...keys.values()];
}

/** BatchGet in chunks of 100 (the DynamoDB ceiling), split by PK prefix. */
export async function loadLookups(rows: readonly Item[]): Promise<Lookups> {
  const table = process.env.TABLE_NAME ?? "";
  const db = getDocClient();
  const lookups: Lookups = { seriesById: new Map(), channelsById: new Map(), profilesById: new Map() };
  const keys = lookupKeysFor(rows);
  for (let i = 0; i < keys.length; i += BATCH_GET_MAX) {
    const chunk = keys.slice(i, i + BATCH_GET_MAX);
    const out = await db.send(new BatchGetCommand({ RequestItems: { [table]: { Keys: chunk } } }));
    for (const item of (out.Responses?.[table] ?? []) as Item[]) {
      const pk = String(item["PK"]);
      const id = String(item["id"]);
      if (pk.startsWith(SERIES_PK_PREFIX)) lookups.seriesById.set(id, item);
      else if (pk.startsWith(CHANNEL_PK_PREFIX)) lookups.channelsById.set(id, item);
      else if (pk.startsWith(ATHLETE_PK_PREFIX)) lookups.profilesById.set(id, item);
    }
  }
  return lookups;
}

export interface BuildOptions {
  partner: Partner;
  canonicalBase: string;
  now?: Date;
  /** include withdrawn rows (for /changes); default false */
  includeWithdrawn?: boolean;
  signer?: PartnerSigner;
}

/**
 * Pure mapping once lookups and a signer are in hand: the partner-visible
 * assets in a batch of candidate rows, in the order given. Rows the partner
 * may not see are dropped silently — the API never says "exists but not
 * for you".
 */
export function assetsFromLookups(
  rows: readonly Item[],
  lookups: Lookups,
  options: BuildOptions & { signer: PartnerSigner },
): PartnerAsset[] {
  const now = options.now ?? new Date();
  const expiresAt = weeklyExpiry(now);
  const assets: PartnerAsset[] = [];
  for (const row of rows) {
    const series = str(row["seriesId"]) ? lookups.seriesById.get(String(row["seriesId"])) : undefined;
    const withdrawn = typeof row["withdrawnAt"] === "string";
    const verdict = isSyndicable(row, series, options.partner, now);
    const allowed = withdrawn
      ? options.includeWithdrawn === true && verdict.reasons.every((reason) => reason === "withdrawn")
      : verdict.eligible;
    if (!allowed) continue;
    const channel = lookups.channelsById.get(String(row["channelId"]));
    if (!channel) continue;
    const asset = toPartnerAsset({
      row,
      series,
      channel,
      profilesById: lookups.profilesById,
      partner: options.partner,
      canonicalBase: options.canonicalBase,
      sign: options.signer.sign,
      expiresAt,
    });
    if (asset) assets.push(asset);
  }
  return assets;
}

/** Lookups + signer + mapping in one call, for the request-path handlers. */
export async function buildAssets(rows: readonly Item[], options: BuildOptions & { lookups?: Lookups }): Promise<PartnerAsset[]> {
  const lookups = options.lookups ?? (await loadLookups(rows));
  const signer = options.signer ?? (await getPartnerSigner());
  return assetsFromLookups(rows, lookups, { ...options, signer });
}
