/**
 * feed-build — scheduled (every 15 minutes) and on demand: rebuilds every
 * partner's Media RSS and JSON feeds from the syndication index and writes
 * them to the video bucket under feeds/{partnerId}-{feedToken}.{xml,json},
 * served by CloudFront at /feeds/* with a five-minute cache.
 *
 * Static files on a CDN are the whole point: a hundred partners polling
 * every five minutes cost nothing and cannot load the origin. Signed media
 * URLs inside use the weekly-aligned expiry, so two builds in the same week
 * produce byte-identical URLs and a poller's cache stays warm.
 *
 * A suspended partner's feed is rebuilt EMPTY with a reason in the channel
 * description (the kill switch), never left stale.
 */
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { Partner } from "@niltv/types";
import { GSI1, GSI3, PARTNERS_ALL_GSI1PK, SYND_ALL_GSI3PK, getDocClient } from "../../lib/db";
import { buildJsonFeed, buildMrss, type FeedMeta } from "../../lib/mrss";
import { getPartnerSigner } from "../../lib/partner-signing";
import { getS3Client } from "../../lib/s3";
import type { Item } from "../../lib/shape";
import { assetsFromLookups, loadLookups } from "../partner/catalogue";

/** Items per feed document. Partners wanting the rest use the API's cursor. */
const FEED_MAX_ITEMS = 500;
/** Index pages walked (500 rows each) to fill FEED_MAX_ITEMS after filtering. */
const MAX_INDEX_PAGES = 6;

async function listPartners(table: string): Promise<Partner[]> {
  const out = await getDocClient().send(
    new QueryCommand({
      TableName: table,
      IndexName: GSI1,
      KeyConditionExpression: "GSI1PK = :pk",
      ExpressionAttributeValues: { ":pk": PARTNERS_ALL_GSI1PK },
    }),
  );
  return (out.Items ?? [])
    .map((item) => Partner.safeParse(item))
    .filter((r): r is { success: true; data: Partner } => r.success)
    .map((r) => r.data);
}

/** Newest-first syndication candidates, up to a bounded number of index pages. */
async function listCandidates(table: string): Promise<Item[]> {
  const rows: Item[] = [];
  let startKey: Record<string, unknown> | undefined;
  for (let page = 0; page < MAX_INDEX_PAGES; page += 1) {
    const out = await getDocClient().send(
      new QueryCommand({
        TableName: table,
        IndexName: GSI3,
        KeyConditionExpression: "GSI3PK = :pk",
        ExpressionAttributeValues: { ":pk": SYND_ALL_GSI3PK },
        ScanIndexForward: false,
        Limit: 500,
        ExclusiveStartKey: startKey,
      }),
    );
    rows.push(...((out.Items ?? []) as Item[]));
    startKey = out.LastEvaluatedKey as Record<string, unknown> | undefined;
    if (!startKey) break;
  }
  return rows;
}

export const handler = async (): Promise<void> => {
  const table = process.env.TABLE_NAME ?? "";
  const bucket = process.env.OUTPUT_BUCKET ?? "";
  const publicBase = process.env.PLAYBACK_BASE_URL ?? "";
  const siteOrigin = process.env.SITE_ORIGIN ?? "https://niltv.com";
  const now = new Date();

  const partners = (await listPartners(table)).filter((p) => p.feedToken);
  if (partners.length === 0) {
    console.log("feed-build: no partners with a feed token — nothing to build");
    return;
  }

  const rows = await listCandidates(table);
  const lookups = await loadLookups(rows);
  const signer = await getPartnerSigner();
  const s3 = getS3Client();

  for (const partner of partners) {
    const name = `${partner.id}-${partner.feedToken}`;
    const assets =
      partner.status === "active"
        ? assetsFromLookups(rows, lookups, { partner, canonicalBase: siteOrigin, now, signer }).slice(0, FEED_MAX_ITEMS)
        : [];
    const meta: FeedMeta = {
      title: `NIL TV for ${partner.name}`,
      link: siteOrigin,
      description:
        partner.status === "active"
          ? `NIL TV video licensed to ${partner.name}. Files are signed and expire; re-fetch this feed for fresh links.`
          : `This feed is suspended. Contact NIL TV.`,
      selfUrl: `${publicBase}/feeds/${name}.xml`,
      generatedAt: now,
    };
    const xml = buildMrss(meta, assets);
    const jsonBody = buildJsonFeed({ ...meta, selfUrl: `${publicBase}/feeds/${name}.json` }, assets);
    await Promise.all([
      s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: `feeds/${name}.xml`,
          Body: xml,
          ContentType: "application/rss+xml; charset=utf-8",
          CacheControl: "public, max-age=300",
        }),
      ),
      s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: `feeds/${name}.json`,
          Body: jsonBody,
          ContentType: "application/json; charset=utf-8",
          CacheControl: "public, max-age=300",
        }),
      ),
    ]);
    console.log(`feed-build: ${partner.id} ← ${assets.length} items (${partner.status})`);
  }
};
