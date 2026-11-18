import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DashboardLibraryItem, DashboardLibrarySync } from "@niltv/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  athletesFor,
  buildLibrarySync,
  igPostIdFor,
  isPublicMediaUrl,
  libraryItemFor,
  libraryQcState,
  libraryScanInput,
  type LibraryContext,
  type LibrarySyncDeps,
  type LibrarySyncOptions,
  publicMediaUrl,
  runLibrarySync,
} from "./library-sync";
import type { Item } from "./shape";

// All sample data is invented: example.test hosts, made-up ids and handles.
const BASE = "https://cdn.example.test";

const channels = new Map<string, Item>([
  ["ch-niltv", { PK: "CHANNEL#ch-niltv", id: "ch-niltv", name: "NIL TV" }],
  ["ch-samplecitytv", { PK: "CHANNEL#ch-samplecitytv", id: "ch-samplecitytv", name: "Sample City TV" }],
]);

const profilesById = new Map<string, Item>([
  ["ath-sample-one", { id: "ath-sample-one", name: "Sample Athlete One", handle: "sample_athlete_one" }],
  ["ath-sample-two", { id: "ath-sample-two", name: "Sample Athlete Two", handle: "sample_athlete_two" }],
]);

const ctx: LibraryContext = { channels, profilesById, playbackBase: BASE };

/** A fully tagged Instagram collab clip, as ingest + enrichment store it. */
const taggedRow = (overrides: Item = {}): Item => ({
  PK: "CONTENT#ig-17000000000000001",
  id: "ig-17000000000000001",
  title: "Game day walkout",
  channelId: "ch-samplecitytv",
  athleteId: "ath-sample-one",
  featuredAthleteIds: ["ath-sample-one", "ath-sample-two"],
  description: "Game day walkout with the squad",
  source: {
    kind: "instagram-collab",
    account: "samplecitytv",
    authorHandle: "sample_athlete_one",
    postId: "17000000000000001",
    url: "https://www.instagram.com/reel/SAMPLE001/",
    postedAt: "2026-10-01T15:00:00Z",
    caption: "Game day walkout with the squad #gameday",
    mediaType: "VIDEO",
  },
  summary: "Two athletes walk out before kickoff.",
  keywords: ["game day", "walkout"],
  sport: "soccer",
  school: "Sample State",
  contentType: "game-day",
  contentTypes: ["game-day", "bts"],
  categories: ["Game Day"],
  sponsor: "Sample Brand",
  unresolvedHandles: ["unknown_handle"],
  transcodeStatus: "published",
  qc: { app: "ready", site: "ready", partners: "needs-tagging", reasons: ["unresolved handles"], at: "2026-10-02T00:00:00.000Z" },
  playbackPath: "/video/ig-17000000000000001/master.mp4",
  thumbPath: "/video/ig-17000000000000001/poster.jpg",
  duration: 23,
  publishedAt: "2026-10-01T15:00:00.000Z",
  sourcePlatform: "instagram",
  sourcePostId: "17000000000000001",
  syndicationUpdatedAt: "2026-10-03T00:00:00.000Z",
  ...overrides,
});

/** A row with almost nothing on it. */
const sparseRow = (): Item => ({
  PK: "CONTENT#ig-17000000000000002",
  id: "ig-17000000000000002",
  title: "Sample City TV",
  channelId: "ch-unknown",
  athleteId: "p-samplecitytv",
  transcodeStatus: "published",
  sourcePlatform: "instagram",
  sourcePostId: "17000000000000002",
});

/** A staff upload (HLS, not from Instagram). */
const uploadRow = (): Item => ({
  PK: "CONTENT#up-sample-feature",
  id: "up-sample-feature",
  title: "Sample feature episode",
  channelId: "ch-niltv",
  athleteId: "ath-sample-two",
  description: "A staff upload.",
  source: { kind: "upload", reference: "sample/folder" },
  transcodeStatus: "published",
  withdrawnAt: "2026-10-05T00:00:00.000Z",
  qc: { app: "needs-review", site: "needs-review", partners: "needs-review", reasons: ["no poster"], at: "2026-10-04T00:00:00.000Z" },
  playbackPath: "/video/up-sample-feature/index.m3u8",
  duration: 612.5,
  publishedAt: "2026-09-20T12:00:00.000Z",
});

describe("libraryItemFor", () => {
  it("maps a fully tagged row", () => {
    const item = libraryItemFor(taggedRow(), ctx);
    expect(DashboardLibraryItem.parse(item)).toEqual(item);
    expect(item).toEqual({
      content_id: "ig-17000000000000001",
      ig_post_id: "17000000000000001",
      channel_id: "ch-samplecitytv",
      channel_name: "Sample City TV",
      title: "Game day walkout",
      caption: "Game day walkout with the squad #gameday",
      summary: "Two athletes walk out before kickoff.",
      keywords: ["game day", "walkout"],
      sport: "soccer",
      school: "Sample State",
      content_type: "game-day",
      content_types: ["game-day", "bts"],
      categories: ["Game Day"],
      sponsor: "Sample Brand",
      athletes: [
        { id: "ath-sample-one", name: "Sample Athlete One", handle: "sample_athlete_one" },
        { id: "ath-sample-two", name: "Sample Athlete Two", handle: "sample_athlete_two" },
      ],
      unresolved_handles: ["unknown_handle"],
      status: "published",
      qc_state: "needs-tagging",
      poster_url: `${BASE}/video/ig-17000000000000001/poster.jpg`,
      video_url: `${BASE}/video/ig-17000000000000001/master.mp4`,
      duration_sec: 23,
      posted_at: "2026-10-01T15:00:00.000Z",
      updated_at: "2026-10-03T00:00:00.000Z",
    });
  });

  it("gives null for absent scalars and [] for absent lists", () => {
    const item = libraryItemFor(sparseRow(), ctx);
    expect(DashboardLibraryItem.parse(item)).toEqual(item);
    expect(item).toMatchObject({
      ig_post_id: "17000000000000002",
      channel_id: "ch-unknown",
      channel_name: null,
      caption: null,
      summary: null,
      keywords: [],
      sport: null,
      school: null,
      content_type: null,
      content_types: [],
      categories: [],
      sponsor: null,
      athletes: [],
      unresolved_handles: [],
      qc_state: null,
      poster_url: null,
      video_url: null,
      duration_sec: null,
      posted_at: null,
      updated_at: null,
    });
  });

  it("leaves ig_post_id null for a clip that did not come from Instagram", () => {
    const item = libraryItemFor(uploadRow(), ctx);
    expect(item.ig_post_id).toBeNull();
    expect(item.status).toBe("withdrawn");
    expect(item.qc_state).toBe("needs-review");
    expect(item.caption).toBe("A staff upload.");
    expect(item.video_url).toBe(`${BASE}/video/up-sample-feature/index.m3u8`);
    expect(item.poster_url).toBeNull();
  });

  it("never carries rights, files or other row internals", () => {
    const item = libraryItemFor(
      taggedRow({ rights: { status: "owned" }, files: { sourcePath: "/originals/x/master.mp4" }, overrides: ["title"] }),
      ctx,
    );
    expect(Object.keys(item).sort()).toEqual(Object.keys(DashboardLibraryItem.shape).sort());
  });
});

describe("igPostIdFor", () => {
  it("reads the source record first, then the legacy fields", () => {
    expect(igPostIdFor({ source: { kind: "instagram-owned", postId: "111" } })).toBe("111");
    expect(igPostIdFor({ sourcePlatform: "instagram", sourcePostId: "222" })).toBe("222");
    expect(igPostIdFor({ source: { kind: "archive", postId: "333" } })).toBeNull();
    expect(igPostIdFor({ sourcePlatform: "youtube", sourcePostId: "444" })).toBeNull();
  });
});

describe("athletesFor", () => {
  it("resolves ids to name and handle, once each, in credit order", () => {
    const row = { athleteId: "ath-sample-two", featuredAthleteIds: ["ath-sample-one", "ath-sample-two"] };
    expect(athletesFor(row, profilesById).map((a) => a.handle)).toEqual(["sample_athlete_two", "sample_athlete_one"]);
  });

  it("drops channel pseudo-profiles and keeps unknown ids with null name and handle", () => {
    const row = { athleteId: "p-niltv", featuredAthleteIds: ["ath-missing"] };
    expect(athletesFor(row, profilesById)).toEqual([{ id: "ath-missing", name: null, handle: null }]);
  });
});

describe("publicMediaUrl", () => {
  it("builds base + path for /video/ paths and trims a trailing slash on the base", () => {
    expect(publicMediaUrl({ thumbPath: "/video/a/poster.jpg" }, "thumbUrl", "thumbPath", `${BASE}/`)).toBe(
      `${BASE}/video/a/poster.jpg`,
    );
  });

  it("prefers a stored public URL", () => {
    expect(
      publicMediaUrl({ playbackUrl: "https://www.youtube.com/embed/sample", playbackPath: "/video/a/master.mp4" }, "playbackUrl", "playbackPath", BASE),
    ).toBe("https://www.youtube.com/embed/sample");
  });

  it("refuses bucket URLs, presigned URLs and non-public paths", () => {
    expect(publicMediaUrl({ playbackUrl: "https://sample-bucket.s3.amazonaws.com/masters/a.mp4" }, "playbackUrl", "playbackPath", BASE)).toBeNull();
    expect(publicMediaUrl({ playbackUrl: "https://s3.us-east-1.amazonaws.com/sample-bucket/a.mp4" }, "playbackUrl", "playbackPath", BASE)).toBeNull();
    expect(publicMediaUrl({ playbackPath: "/originals/a/master.mp4" }, "playbackUrl", "playbackPath", BASE)).toBeNull();
    expect(publicMediaUrl({ playbackPath: "/video/a/master.mp4" }, "playbackUrl", "playbackPath", "")).toBeNull();
    expect(isPublicMediaUrl(`${BASE}/video/a.mp4?X-Amz-Signature=abc`)).toBe(false);
    expect(isPublicMediaUrl("http://cdn.example.test/video/a.mp4")).toBe(false);
  });
});

describe("libraryQcState", () => {
  it("reports the app verdict first, then tagging gaps, then the site verdict", () => {
    expect(libraryQcState({ qc: { app: "needs-review", site: "needs-review", partners: "needs-tagging" } })).toBe("needs-review");
    expect(libraryQcState({ qc: { app: "ready", site: "needs-tagging", partners: "ready" } })).toBe("needs-tagging");
    expect(libraryQcState({ qc: { app: "ready", site: "ready", partners: "needs-rights" } })).toBe("ready");
    expect(libraryQcState({})).toBeNull();
  });
});

describe("libraryScanInput", () => {
  it("projects only the listed attributes and filters out tombstones", () => {
    const input = libraryScanInput("niltv-test", { PK: "CONTENT#x", SK: "META" });
    expect(input.ProjectionExpression).not.toContain("rights");
    expect(Object.values(input.ExpressionAttributeNames ?? {})).not.toContain("rights");
    expect(input.FilterExpression).toContain("attribute_not_exists(#removed)");
    expect(input.ExclusiveStartKey).toEqual({ PK: "CONTENT#x", SK: "META" });
  });
});

describe("buildLibrarySync", () => {
  it("produces a body the contract accepts, ordered by content id", () => {
    const body = buildLibrarySync([uploadRow(), taggedRow(), sparseRow()], ctx, {
      stage: "dev",
      generatedAt: new Date("2026-11-18T12:00:00Z"),
    });
    expect(DashboardLibrarySync.parse(body)).toEqual(body);
    expect(body.full).toBe(true);
    expect(body.items.map((i) => i.content_id)).toEqual([
      "ig-17000000000000001",
      "ig-17000000000000002",
      "up-sample-feature",
    ]);
  });
});

/* ── runLibrarySync ───────────────────────────────────────────────────────── */

const options = (overrides: Partial<LibrarySyncOptions> = {}): LibrarySyncOptions => ({
  enabled: true,
  table: "niltv-test",
  stage: "dev",
  playbackBase: BASE,
  dashboardUrl: "https://dashboard.example.test",
  now: new Date("2026-11-18T12:00:00Z"),
  ...overrides,
});

const okResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function deps(overrides: Partial<LibrarySyncDeps> = {}): LibrarySyncDeps & { fetch: ReturnType<typeof vi.fn> } {
  const fetchMock = vi.fn(async () => okResponse({ received: 3, upserted: 3, removed: 1 }));
  return {
    loadRows: async () => ({ content: [taggedRow(), sparseRow(), uploadRow()], channels }),
    loadProfiles: async () => [...profilesById.values()],
    getApiKey: async () => "sample-key",
    fetch: fetchMock,
    ...overrides,
  } as LibrarySyncDeps & { fetch: ReturnType<typeof vi.fn> };
}

describe("runLibrarySync", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it("does nothing when the flag is off", async () => {
    const d = deps();
    const loadRows = vi.fn(d.loadRows);
    expect(await runLibrarySync(options({ enabled: false }), { ...d, loadRows })).toEqual({ status: "disabled" });
    expect(d.fetch).not.toHaveBeenCalled();
    expect(loadRows).not.toHaveBeenCalled();
  });

  it("POSTs one full snapshot with the API key and reports the counts", async () => {
    const d = deps();
    const outcome = await runLibrarySync(options(), d);
    expect(outcome).toEqual({ status: "sent", items: 3, received: 3, upserted: 3, removed: 1 });
    expect(d.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = d.fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://dashboard.example.test/api/library/sync");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["X-API-Key"]).toBe("sample-key");
    const body = DashboardLibrarySync.parse(JSON.parse(String(init.body)));
    expect(body.full).toBe(true);
    expect(body.items).toHaveLength(3);
    expect(console.log).toHaveBeenCalledWith(
      "library-sync: status=sent items=3 received=3 upserted=3 removed=1",
    );
  });

  it("never throws when the request fails", async () => {
    const d = deps({ fetch: vi.fn(async () => Promise.reject(new Error("connect ECONNREFUSED"))) as never });
    const outcome = await runLibrarySync(options(), d);
    expect(outcome).toMatchObject({ status: "failed", items: 3 });
    expect(console.error).toHaveBeenCalled();
  });

  it("never throws on an error status or when the table read fails", async () => {
    const err500 = deps({ fetch: vi.fn(async () => new Response("boom", { status: 500 })) as never });
    expect(await runLibrarySync(options(), err500)).toMatchObject({ status: "failed", error: "HTTP 500 boom" });
    const scanFails = deps({ loadRows: async () => Promise.reject(new Error("throttled")) });
    expect(await runLibrarySync(options(), scanFails)).toMatchObject({ status: "failed", error: "throttled" });
    expect(scanFails.fetch).not.toHaveBeenCalled();
  });

  it("skips, never truncates, above 5000 rows", async () => {
    const many = Array.from({ length: 5001 }, (_, i) => ({ ...sparseRow(), id: `ig-${i}`, PK: `CONTENT#ig-${i}` }));
    const d = deps({ loadRows: async () => ({ content: many, channels }) });
    const outcome = await runLibrarySync(options(), d);
    expect(outcome).toEqual({ status: "skipped", reason: "over item limit", items: 5001 });
    expect(d.fetch).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalled();
  });

  it("skips a stage the contract does not know", async () => {
    const d = deps();
    expect(await runLibrarySync(options({ stage: "test" }), d)).toMatchObject({ status: "skipped" });
    expect(d.fetch).not.toHaveBeenCalled();
  });
});

/* ── Contract fixture for the dashboard side ──────────────────────────────── */

const FIXTURE = join(__dirname, "..", "..", "test", "fixtures", "dashboard-library-sync.sample.json");

describe("dashboard contract fixture", () => {
  // Regenerate after a mapping change: UPDATE_FIXTURES=1 npx vitest run src/lib/library-sync.test.ts
  it("matches what the mapping code produces from the sample rows", () => {
    const body = buildLibrarySync([taggedRow(), sparseRow(), uploadRow()], ctx, {
      stage: "dev",
      generatedAt: new Date("2026-11-18T12:00:00Z"),
    });
    const text = `${JSON.stringify(body, null, 2)}\n`;
    if (process.env.UPDATE_FIXTURES === "1") {
      mkdirSync(dirname(FIXTURE), { recursive: true });
      writeFileSync(FIXTURE, text);
    }
    expect(readFileSync(FIXTURE, "utf8").replace(/\r\n/g, "\n")).toBe(text);
    expect(DashboardLibrarySync.parse(JSON.parse(text))).toEqual(body);
  });
});
