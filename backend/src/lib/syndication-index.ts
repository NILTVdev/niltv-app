/**
 * Keeping the GSI3 syndication index in step with a content row. Every
 * write path that can change a row's candidacy (admin tagging, publish and
 * unpublish, withdraw and restore) calls `stampSyndicationIndex` after its
 * own write, so the index never encodes a rule of its own — it only mirrors
 * lib/syndication's `syndicationIndexKeys`.
 */
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { contentKey, getDocClient, seriesKey, SYND_ALL_GSI3PK } from "./db";
import { qcFor } from "./enrich";
import type { Item } from "./shape";
import { syndicationIndexKeys } from "./syndication";

/** The series row a content row inherits rights defaults from, if any. */
export async function loadSeriesFor(row: Item): Promise<Item | undefined> {
  const seriesId = row["seriesId"];
  if (typeof seriesId !== "string" || seriesId.length === 0) return undefined;
  const { Item } = await getDocClient().send(
    new GetCommand({ TableName: process.env.TABLE_NAME ?? "", Key: seriesKey(seriesId) }),
  );
  return Item as Item | undefined;
}

/**
 * SET or REMOVE the row's GSI3 keys to match what the rule says. Idempotent;
 * safe to call after any write. Returns the keys now on the row.
 */
export async function stampSyndicationIndex(
  row: Item,
  series?: Item,
): Promise<{ GSI3PK: string; GSI3SK: string } | undefined> {
  const table = process.env.TABLE_NAME ?? "";
  const contentId = String(row["id"]);
  const keys = syndicationIndexKeys(row, series ?? (await loadSeriesFor(row)));
  await getDocClient().send(
    new UpdateCommand({
      TableName: table,
      Key: contentKey(contentId),
      ConditionExpression: "attribute_exists(PK)",
      ...(keys
        ? {
            UpdateExpression: "SET GSI3PK = :pk, GSI3SK = :sk",
            ExpressionAttributeValues: { ":pk": keys.GSI3PK, ":sk": keys.GSI3SK },
          }
        : { UpdateExpression: "REMOVE GSI3PK, GSI3SK" }),
    }),
  );
  return keys;
}

/** Fields whose change is "substantive" for partners — bumping syndicationUpdatedAt makes them re-fetch. */
export const SYNDICATION_FIELDS = [
  "title",
  "description",
  "assetType",
  "seriesId",
  "featuredAthleteIds",
  "rights",
  "platformIds",
  "tags",
  "files",
] as const;

/**
 * Recompute the per-surface QC verdict and the GSI3 keys for a row in one
 * write (content foundation). Returns the row as it now stands.
 */
/**
 * A row that enters or leaves the index gets a fresh `syndicationUpdatedAt`,
 * so a partner's delta poll (`/changes?since=`) sees it as a change; a row
 * whose membership did not move keeps its stamp and its place in the order.
 * Without this, a rule change that makes rows eligible would be
 * invisible to a partner polling for changes.
 */
export function withMembershipStamp(row: Item, series?: Item, now: Date = new Date()): { row: Item; keys: ReturnType<typeof syndicationIndexKeys> } {
  const wasIn = typeof row["GSI3PK"] === "string";
  const next: Item = { ...row };
  let keys = syndicationIndexKeys(next, series);
  if (Boolean(keys) !== wasIn) {
    next["syndicationUpdatedAt"] = now.toISOString();
    keys = syndicationIndexKeys(next, series);
  }
  return { row: next, keys };
}

export async function stampQcAndIndex(row: Item, series?: Item): Promise<Item> {
  const table = process.env.TABLE_NAME ?? "";
  const contentId = String(row["id"]);
  const resolvedSeries = series ?? (await loadSeriesFor(row));
  const qc = qcFor(row, { series: resolvedSeries });
  const { row: stamped, keys } = withMembershipStamp({ ...row, qc }, resolvedSeries);
  const bumped = stamped["syndicationUpdatedAt"] !== row["syndicationUpdatedAt"];
  const stampClause = bumped ? ", syndicationUpdatedAt = :su" : "";
  const stampValue = bumped ? { ":su": stamped["syndicationUpdatedAt"] } : {};
  await getDocClient().send(
    new UpdateCommand({
      TableName: table,
      Key: contentKey(contentId),
      ConditionExpression: "attribute_exists(PK)",
      UpdateExpression: keys ? `SET qc = :qc, GSI3PK = :pk, GSI3SK = :sk${stampClause}` : `SET qc = :qc${stampClause} REMOVE GSI3PK, GSI3SK`,
      ExpressionAttributeValues: keys ? { ":qc": qc, ":pk": keys.GSI3PK, ":sk": keys.GSI3SK, ...stampValue } : { ":qc": qc, ...stampValue },
    }),
  );
  return { ...stamped, ...(keys ?? {}) };
}

/**
 * A page cursor for the syndication index must carry exactly the key
 * attributes a GSI3 query hands back. Anything else — a cursor minted for
 * another index, a hand-built one pointing at some other partition — is the
 * caller's bad cursor and must be a 400, never a DynamoDB ValidationException
 * surfacing as a 500.
 */
export function decodeSyndicationCursor(raw: string | undefined): Record<string, string> | undefined {
  if (!raw) return undefined;
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
  if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) return undefined;
  const key = decoded as Record<string, unknown>;
  const fields = ["PK", "SK", "GSI3PK", "GSI3SK"] as const;
  if (Object.keys(key).length !== fields.length) return undefined;
  if (!fields.every((f) => typeof key[f] === "string" && (key[f] as string).length > 0 && (key[f] as string).length <= 512)) return undefined;
  if (key["GSI3PK"] !== SYND_ALL_GSI3PK || !(key["PK"] as string).startsWith("CONTENT#") || key["SK"] !== "META") return undefined;
  return key as Record<string, string>;
}

