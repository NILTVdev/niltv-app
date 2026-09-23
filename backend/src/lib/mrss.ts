/**
 * Feed writers for the partner content API: Media RSS (what portal and CTV
 * ingest systems poll) and a JSON twin for partners who build their own
 * adapter. Both take the same PartnerAsset list from lib/syndication, so the
 * feed can never disagree with the API.
 *
 * Media RSS 1.5.1 (rssboard.org/media-rss) on RSS 2.0, with Dublin Core terms
 * for the validity window. The version stamp partners refetch on is emitted
 * twice, as `<atom:updated>` and `<dcterms:modified>`: both are namespaced,
 * so the W3C validator passes (a bare `<updated>` is an "undefined item
 * element" error there) while every reader that keys
 * on an updated stamp still finds one.
 */
import type { PartnerAsset } from "@niltv/types";

export interface FeedMeta {
  title: string;
  /** the site the feed represents */
  link: string;
  description: string;
  /** the feed's own URL (atom:link rel="self") */
  selfUrl: string;
  generatedAt: Date;
  /** RFC 5005 paging: the next page's URL, when the feed is split */
  nextUrl?: string;
}

const escapeXml = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

const attr = (value: string | number): string => `"${escapeXml(String(value))}"`;

/** RFC 822 date as RSS wants it (toUTCString yields the RFC 1123 profile every reader accepts). */
const rfc822 = (iso: string): string => new Date(iso).toUTCString();

function itemXml(asset: PartnerAsset): string {
  const lines: string[] = [];
  lines.push(`    <item>`);
  lines.push(`      <guid isPermaLink="false">${escapeXml(asset.id)}</guid>`);
  lines.push(`      <title>${escapeXml(asset.title)}</title>`);
  lines.push(`      <description>${escapeXml(asset.description)}</description>`);
  lines.push(`      <link>${escapeXml(asset.canonicalUrl)}</link>`);
  lines.push(`      <pubDate>${rfc822(asset.publishedAt)}</pubDate>`);
  lines.push(`      <atom:updated>${escapeXml(asset.updatedAt)}</atom:updated>`);
  lines.push(`      <dcterms:modified>${escapeXml(asset.updatedAt)}</dcterms:modified>`);
  lines.push(`      <category>${escapeXml(asset.category)}</category>`);

  const mp4 = asset.files.mp4;
  const contentAttrs = [
    `url=${attr(mp4.url)}`,
    `type=${attr(mp4.type)}`,
    `medium="video"`,
    `isDefault="true"`,
    ...(asset.duration !== undefined ? [`duration=${attr(Math.round(asset.duration))}`] : []),
    ...(mp4.width ? [`width=${attr(mp4.width)}`] : []),
    ...(mp4.height ? [`height=${attr(mp4.height)}`] : []),
    ...(mp4.bytes ? [`fileSize=${attr(mp4.bytes)}`] : []),
  ];
  lines.push(`      <media:content ${contentAttrs.join(" ")} />`);
  if (asset.files.vertical) {
    const v = asset.files.vertical;
    lines.push(
      `      <media:content url=${attr(v.url)} type=${attr(v.type)} medium="video" isDefault="false"` +
        `${v.width ? ` width=${attr(v.width)}` : ""}${v.height ? ` height=${attr(v.height)}` : ""} />`,
    );
  }
  if (asset.files.poster) {
    const p = asset.files.poster;
    lines.push(
      `      <media:thumbnail url=${attr(p.url)}${p.width ? ` width=${attr(p.width)}` : ""}${p.height ? ` height=${attr(p.height)}` : ""} />`,
    );
  }
  if (asset.files.captions) {
    lines.push(`      <media:subTitle type=${attr(asset.files.captions.type)} lang="en-US" href=${attr(asset.files.captions.url)} />`);
  }
  lines.push(`      <media:credit role="author" scheme="urn:ebu">${escapeXml(asset.credit)}</media:credit>`);
  if (asset.tags.length > 0) {
    lines.push(`      <media:keywords>${escapeXml(asset.tags.slice(0, 10).join(", "))}</media:keywords>`);
  }
  // Validity window (Dublin Core "Period" encoding), only when a licence sets an expiry.
  if (asset.expiresAt) lines.push(`      <dcterms:valid>${escapeXml(`end=${asset.expiresAt}; scheme=W3C-DTF`)}</dcterms:valid>`);
  lines.push(`    </item>`);
  return lines.join("\n");
}

/** The Media RSS document. Withdrawn assets are excluded by the caller — a feed is the live set only. */
export function buildMrss(meta: FeedMeta, assets: readonly PartnerAsset[]): string {
  const head = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<rss version="2.0"`,
    `     xmlns:media="http://search.yahoo.com/mrss/"`,
    `     xmlns:dcterms="http://purl.org/dc/terms/"`,
    `     xmlns:atom="http://www.w3.org/2005/Atom">`,
    `  <channel>`,
    `    <title>${escapeXml(meta.title)}</title>`,
    `    <link>${escapeXml(meta.link)}</link>`,
    `    <description>${escapeXml(meta.description)}</description>`,
    `    <language>en-us</language>`,
    `    <lastBuildDate>${meta.generatedAt.toUTCString()}</lastBuildDate>`,
    `    <atom:link href=${attr(meta.selfUrl)} rel="self" type="application/rss+xml" />`,
    ...(meta.nextUrl ? [`    <atom:link href=${attr(meta.nextUrl)} rel="next" type="application/rss+xml" />`] : []),
  ];
  const tail = [`  </channel>`, `</rss>`, ``];
  return [...head, ...assets.map(itemXml), ...tail].join("\n");
}

/** The JSON twin: same items, same order, plus the feed metadata. */
export function buildJsonFeed(meta: FeedMeta, assets: readonly PartnerAsset[]): string {
  return JSON.stringify(
    {
      version: "niltv-partner-feed/1",
      title: meta.title,
      link: meta.link,
      description: meta.description,
      self: meta.selfUrl,
      ...(meta.nextUrl ? { next: meta.nextUrl } : {}),
      generatedAt: meta.generatedAt.toISOString(),
      items: assets,
    },
    null,
    2,
  );
}
