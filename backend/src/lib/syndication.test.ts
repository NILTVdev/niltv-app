import { Partner } from "@niltv/types";
import { describe, expect, it } from "vitest";
import { buildMrss } from "./mrss";
import { decodeSyndicationCursor, withMembershipStamp } from "./syndication-index";
import { SYND_ALL_GSI3PK } from "./db";
import {
  availableFromOf,
  baseEligibility,
  cleanDescription,
  cleanTitle,
  isIndexCandidate,
  isSyndicable,
  partnerScope,
  resolveSyndicationFiles,
  syndicationIndexKeys,
  toPartnerAsset,
  weeklyExpiry,
} from "./syndication";

const NOW = new Date("2026-09-08T12:00:00Z");

const socialRow = (overrides: Record<string, unknown> = {}) => ({
  PK: "CONTENT#ig-1",
  SK: "META",
  id: "ig-1",
  title: "An evening well-spent at the Example Tennis Club 👏 @exampletennis | #GoTeam 🎾 #collegetennis",
  description: "An evening well-spent at the Example Tennis Club 👏 @exampletennis | #GoTeam 🎾 #collegetennis #truebluetv",
  channelId: "ch-trueblue",
  athleteId: "ath-duke-wten",
  provider: "hls",
  transcodeStatus: "published",
  publishedAt: "2025-11-05T23:51:53Z",
  playbackPath: "/video/ig-1/master.mp4",
  thumbPath: "/video/ig-1/poster.jpg",
  duration: 24,
  sourcePlatform: "instagram",
  sourcePostId: "17866756524474176",
  sourceUrl: "https://www.instagram.com/p/abc/",
  rights: { status: "owned", logoCleared: true, music: "none" },
  ...overrides,
});

const uploadedRow = (overrides: Record<string, unknown> = {}) => ({
  id: "exs-s01e04",
  title: "Example Series S1E4",
  channelId: "ch-niltv",
  athleteId: "ath-a",
  transcodeStatus: "published",
  publishedAt: "2026-09-01T00:00:00Z",
  playbackPath: "/video/exs-s01e04/index.m3u8",
  thumbPath: "/video/exs-s01e04/poster.0000000.jpg",
  seriesId: "example-series",
  assetType: "episode",
  rights: { status: "owned", logoCleared: true, music: "cleared" },
  ...overrides,
});

const partner = (overrides: Record<string, unknown> = {}) =>
  Partner.parse({
    id: "example-network",
    name: "Example Network",
    status: "active",
    licence: { seriesIds: ["example-series"], channelIds: ["ch-trueblue"] },
    createdAt: "2026-09-01T00:00:00Z",
    ...overrides,
  });

describe("baseEligibility", () => {
  it("passes a published, owned, logo-cleared, music-clean row with a file", () => {
    expect(baseEligibility(socialRow(), undefined, NOW)).toEqual({ eligible: true, reasons: [] });
  });

  it("names every failing condition, not just the first", () => {
    const result = baseEligibility(socialRow({ rights: { status: "restricted" }, withdrawnAt: "2026-09-02T00:00:00Z" }), undefined, NOW);
    expect(result.eligible).toBe(false);
    expect(result.reasons).toEqual(
      expect.arrayContaining(["withdrawn", "rights status is restricted", "school marks not cleared", "music is unknown"]),
    );
  });

  it("treats an absent rights record as restricted and unknown", () => {
    const result = baseEligibility(socialRow({ rights: undefined }), undefined, NOW);
    expect(result.reasons).toContain("rights status is restricted");
    expect(result.reasons).toContain("music is unknown");
  });

  it("refuses platform-library music outright", () => {
    const result = baseEligibility(socialRow({ rights: { status: "owned", logoCleared: true, music: "platform" } }), undefined, NOW);
    expect(result.reasons).toEqual(["music is platform"]);
  });

  it("is available once ingested (series delay not enforced) and honours an expiry", () => {
    const series = { id: "pod", syndicationDelayDays: 30 };
    const fresh = socialRow({ publishedAt: "2026-09-01T00:00:00Z", seriesId: "pod" });
    expect(availableFromOf(fresh, series)).toBe("2026-10-01T00:00:00.000Z");
    expect(baseEligibility(fresh, series, NOW).reasons).toEqual([]);

    const expired = socialRow({ rights: { status: "owned", logoCleared: true, music: "none", expiresAt: "2026-09-01T00:00:00Z" } });
    expect(baseEligibility(expired, undefined, NOW).reasons).toEqual(["expired"]);
  });

  it("inherits series default rights under the row's own values", () => {
    const series = { id: "exs", defaultRights: { status: "owned", logoCleared: true, music: "cleared" } };
    const row = uploadedRow({ rights: { music: "none" } });
    expect(baseEligibility(row, series, NOW).eligible).toBe(true);
  });
});

describe("partnerScope", () => {
  it("licenses by series or by campus channel", () => {
    expect(partnerScope(uploadedRow(), partner(), NOW).eligible).toBe(true);
    expect(partnerScope(socialRow(), partner(), NOW).eligible).toBe(true);
    expect(partnerScope(socialRow({ channelId: "ch-other" }), partner(), NOW).reasons).toEqual([
      "not licensed to this partner",
    ]);
  });

  it("enforces asset types, the term window and suspension", () => {
    const p = partner({ licence: { seriesIds: ["example-series"], assetTypes: ["clip"], termEnd: "2026-09-01T00:00:00Z" }, status: "suspended" });
    expect(partnerScope(uploadedRow(), p, NOW).reasons).toEqual([
      "partner suspended",
      "licence term ended",
      "asset type episode not licensed",
    ]);
  });

  it("isSyndicable concatenates both halves", () => {
    const result = isSyndicable(socialRow({ channelId: "ch-other", rights: { status: "owned", logoCleared: false, music: "none" } }), undefined, partner(), NOW);
    expect(result.reasons).toEqual(["school marks not cleared", "not licensed to this partner"]);
  });
});

describe("index keys", () => {
  it("indexes published owned/licensed rows, keeps withdrawn tombstones, drops restricted", () => {
    expect(isIndexCandidate(socialRow())).toBe(true);
    expect(isIndexCandidate(socialRow({ withdrawnAt: "2026-09-02T00:00:00Z" }))).toBe(true);
    expect(isIndexCandidate(socialRow({ rights: { status: "restricted" } }))).toBe(false);
    expect(isIndexCandidate(socialRow({ transcodeStatus: "ready", publishedAt: undefined }))).toBe(false);
  });

  it("sorts by the syndication stamp, falling back to the publish date", () => {
    expect(syndicationIndexKeys(socialRow())).toEqual({ GSI3PK: "SYND#ALL", GSI3SK: "2025-11-05T23:51:53Z#ig-1" });
    expect(syndicationIndexKeys(socialRow({ syndicationUpdatedAt: "2026-09-08T00:00:00Z" }))?.GSI3SK).toBe(
      "2026-09-08T00:00:00Z#ig-1",
    );
  });
});

describe("resolveSyndicationFiles", () => {
  it("maps a social clip to the video-bucket path with the /video prefix stripped", () => {
    expect(resolveSyndicationFiles(socialRow())).toEqual({ mp4: "/ig-1/master.mp4", poster: "/ig-1/poster.jpg" });
  });

  it("maps an uploaded episode to its master, then to the mezzanine once one exists", () => {
    expect(resolveSyndicationFiles(uploadedRow())).toEqual({
      mp4: "/masters/exs-s01e04/master.mp4",
      poster: "/exs-s01e04/poster.0000000.jpg",
    });
    expect(resolveSyndicationFiles(uploadedRow({ files: { mp4Path: "/exs-s01e04/mezz.mp4", verticalPath: "/exs-s01e04/vertical.mp4" } }))).toEqual({
      mp4: "/exs-s01e04/mezz.mp4",
      vertical: "/exs-s01e04/vertical.mp4",
      source: "/masters/exs-s01e04/master.mp4",
      poster: "/exs-s01e04/poster.0000000.jpg",
    });
  });

  it("prefers an archived original as the source when stamped", () => {
    const paths = resolveSyndicationFiles(socialRow({ files: { sourcePath: "/originals/ig-1/master.mp4" } }));
    expect(paths?.source).toBe("/originals/ig-1/master.mp4");
    expect(paths?.mp4).toBe("/ig-1/master.mp4");
  });

  it("returns undefined for a row with nothing downloadable", () => {
    expect(resolveSyndicationFiles(socialRow({ playbackPath: undefined, playbackUrl: "https://cdn/legacy.m3u8" }))).toBeUndefined();
  });
});

describe("title and description hygiene", () => {
  const fallback = "Duke Women's Tennis, Duke: TrueBlueTV";

  it("keeps the first sentence and drops handles, hashtags and emoji", () => {
    expect(cleanTitle(socialRow().title, fallback)).toBe("An evening well-spent at the Example Tennis Club");
    expect(cleanTitle("Preseason vibes 😓😴 #soccer #preseason #duke", fallback)).toBe("Preseason vibes");
  });

  it("falls back when fewer than two words survive", () => {
    expect(cleanTitle("@nilstar", fallback)).toBe(fallback);
    expect(cleanTitle("🗣️we out here", fallback)).toBe("we out here");
    expect(cleanTitle("", fallback)).toBe(fallback);
  });

  it("caps long captions at a word boundary", () => {
    const long = "word ".repeat(60).trim();
    const title = cleanTitle(long, fallback);
    expect(title.length).toBeLessThanOrEqual(120);
    expect(title.endsWith("word")).toBe(true);
  });

  it("cleans descriptions without inventing text", () => {
    expect(cleanDescription("<b>Preseason</b> vibes 😓 #soccer")).toBe("Preseason vibes");
    expect(cleanDescription("Preseason vibes #soccer", { keepHashtags: true })).toBe("Preseason vibes #soccer");
  });
});

describe("weeklyExpiry", () => {
  it("is the same for every instant in one Monday-to-Sunday week and at least seven days out", () => {
    const monday = new Date("2026-09-07T00:00:00Z"); // a Monday
    const wednesday = new Date("2026-09-09T15:00:00Z");
    const sunday = new Date("2026-09-13T23:59:59Z");
    const expiry = weeklyExpiry(monday);
    expect(expiry.toISOString()).toBe("2026-09-21T00:00:00.000Z");
    expect(weeklyExpiry(wednesday).toISOString()).toBe(expiry.toISOString());
    expect(weeklyExpiry(sunday).toISOString()).toBe(expiry.toISOString());
    expect(expiry.getTime() - sunday.getTime()).toBeGreaterThanOrEqual(7 * 86_400_000);
  });
});

describe("toPartnerAsset + buildMrss", () => {
  const ctx = () => ({
    row: socialRow(),
    channel: { id: "ch-trueblue", name: "TrueBlueTV" },
    profilesById: new Map([["ath-duke-wten", { id: "ath-duke-wten", name: "Duke Women's Tennis", school: "Duke", sport: "Tennis" }]]),
    partner: partner({ categoryMap: { "ch-trueblue": "College Sports" } }),
    canonicalBase: "https://niltv.com",
    sign: (path: string, expiresAt: Date) => `https://dl.example${path}?Expires=${expiresAt.getTime() / 1000}`,
    expiresAt: new Date("2026-09-21T00:00:00Z"),
  });

  it("builds the contract shape from a raw row", () => {
    const asset = toPartnerAsset(ctx());
    expect(asset).toMatchObject({
      id: "ig-1",
      assetType: "clip",
      series: null,
      channel: { id: "ch-trueblue", name: "TrueBlueTV" },
      title: "An evening well-spent at the Example Tennis Club",
      category: "College Sports",
      credit: "Duke Women's Tennis, Duke / NIL TV",
      canonicalUrl: "https://niltv.com/watch/ig-1/",
      platformIds: [{ platform: "instagram", id: "17866756524474176", url: "https://www.instagram.com/p/abc/" }],
      status: "published",
    });
    expect(asset?.files.mp4.url).toBe("https://dl.example/ig-1/master.mp4?Expires=1789948800");
    expect(asset?.files.poster?.type).toBe("image/jpeg");
  });

  it("surfaces the clip's classification to the partner as fields and as a keyword list", () => {
    const asset = toPartnerAsset({
      ...ctx(),
      row: socialRow({ sport: "lacrosse", contentType: "ditl-vlog", contentTypes: ["skit-humor"], school: "Duke", keywords: ["duke", "best friend"], tags: ["hand-set"] }),
    });
    expect(asset?.sport).toBe("lacrosse");
    expect(asset?.contentType).toBe("ditl-vlog");
    expect(asset?.school).toBe("Duke");
    expect(asset?.tags).toEqual(["lacrosse", "ditl-vlog", "skit-humor", "Duke", "best friend", "hand-set"]);

    const blank = toPartnerAsset({ ...ctx(), row: socialRow({ sport: "none-visible", contentType: "other" }) });
    expect(blank?.sport).toBe("none-visible");
    expect(blank?.tags).toEqual([]);
  });

  it("emits a Media RSS document with the elements the portals require, escaped", () => {
    const asset = toPartnerAsset({ ...ctx(), row: socialRow({ title: "Cats & dogs <3 🐾 win big", tags: ["duke", "tennis"] }) });
    expect(asset).toBeDefined();
    const xml = buildMrss(
      { title: "NIL TV for Example Network", link: "https://niltv.com", description: "d", selfUrl: "https://cdn/feeds/y.xml", generatedAt: NOW },
      [asset!],
    );
    expect(xml).toContain('xmlns:media="http://search.yahoo.com/mrss/"');
    expect(xml).toContain('<guid isPermaLink="false">ig-1</guid>');
    expect(xml).toContain("<title>Cats &amp; dogs &lt;3 win big</title>");
    expect(xml).toContain("<pubDate>Wed, 05 Nov 2025 23:51:53 GMT</pubDate>");
    expect(xml).toContain('medium="video" isDefault="true" duration="24"');
    expect(xml).toContain("<media:thumbnail url=");
    expect(xml).toContain("<media:keywords>duke, tennis</media:keywords>");
    expect(xml).not.toContain("<dcterms:valid>");
    expect(xml).toContain('rel="self"');
    expect(xml).toContain("<atom:updated>2025-11-05T23:51:53Z</atom:updated>");
    expect(xml).not.toContain("<updated>");
  });
});

describe("decodeSyndicationCursor", () => {
  const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  it("accepts exactly the key a GSI3 query hands back", () => {
    const key = { PK: "CONTENT#ig-1", SK: "META", GSI3PK: SYND_ALL_GSI3PK, GSI3SK: "2026-09-01T00:00:00Z#ig-1" };
    expect(decodeSyndicationCursor(b64(key))).toEqual(key);
  });
  it("refuses anything that is not that key", () => {
    expect(decodeSyndicationCursor(undefined)).toBeUndefined();
    expect(decodeSyndicationCursor("not-base64!")).toBeUndefined();
    expect(decodeSyndicationCursor(b64({ PK: "PARTNER#p-x", SK: "META" }))).toBeUndefined();
    expect(decodeSyndicationCursor(b64({ PK: "CONTENT#ig-1", SK: "META", GSI3PK: "OTHER", GSI3SK: "x" }))).toBeUndefined();
    expect(decodeSyndicationCursor(b64({ PK: "CONTENT#ig-1", SK: "META", GSI3PK: SYND_ALL_GSI3PK, GSI3SK: "x", extra: 1 }))).toBeUndefined();
    expect(decodeSyndicationCursor(b64([1, 2]))).toBeUndefined();
  });
});

describe("withMembershipStamp", () => {
  const now = new Date("2026-09-11T18:00:00Z");
  it("re-stamps a row that enters the index and leaves an unchanged one alone", () => {
    const eligible = socialRow({ rights: { status: "owned", logoCleared: true, music: "none" }, syndicationUpdatedAt: "2026-09-01T00:00:00Z" });
    const entering = withMembershipStamp(eligible, undefined, now);
    expect(entering.row["syndicationUpdatedAt"]).toBe(now.toISOString());
    expect(entering.keys?.GSI3SK.startsWith(now.toISOString())).toBe(true);

    const already = withMembershipStamp({ ...eligible, GSI3PK: SYND_ALL_GSI3PK, GSI3SK: "x" }, undefined, now);
    expect(already.row["syndicationUpdatedAt"]).toBe("2026-09-01T00:00:00Z");

    const leaving = withMembershipStamp({ ...eligible, GSI3PK: SYND_ALL_GSI3PK, GSI3SK: "x", rights: { status: "restricted", logoCleared: true, music: "none" } }, undefined, now);
    expect(leaving.keys).toBeUndefined();
    expect(leaving.row["syndicationUpdatedAt"]).toBe(now.toISOString());
  });
});

