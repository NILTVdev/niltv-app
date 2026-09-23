import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  decodeCursor,
  directoryChips,
  encodeCursor,
  mapUserPartition,
  resolvePlaybackUrl,
  resolveEventMedia,
  resolveThumbUrl,
  rotateByMinute,
  selectHero,
  sortEvents,
} from "./shape";

/* ── fixtures ─────────────────────────────────────────────────────────────── */

const event = (id: string, status: string, startsAt: string, endsAt: string) => ({
  PK: `EVENT#${id}`,
  SK: "META",
  id,
  title: `Event ${id}`,
  status,
  startsAt,
  endsAt,
});

const live = event("evt-live", "live", "2026-07-13T00:00:00Z", "2026-07-20T00:00:00Z");
const upcomingSoon = event("evt-soon", "upcoming", "2026-08-14T17:00:00Z", "2026-08-21T00:00:00Z");
const upcomingLater = event("evt-later", "upcoming", "2026-10-01T00:00:00Z", "2026-10-15T00:00:00Z");
const endedOld = event("evt-old", "ended", "2026-04-10T00:00:00Z", "2026-04-17T00:00:00Z");
const endedRecent = event("evt-recent", "ended", "2026-05-01T00:00:00Z", "2026-05-08T00:00:00Z");

describe("selectHero (design §6.1 hero states)", () => {
  it("live active event → live hero", () => {
    const hero = selectHero("evt-live", [endedOld, live, upcomingSoon]);
    expect(hero).toMatchObject({ state: "live", event: { id: "evt-live" } });
  });

  it("upcoming active event → upcoming hero", () => {
    const hero = selectHero("evt-soon", [endedOld, upcomingSoon]);
    expect(hero).toMatchObject({ state: "upcoming", event: { id: "evt-soon" } });
  });

  it("ended active event → recap with the most recently ended event", () => {
    const hero = selectHero("evt-old", [endedOld, endedRecent, upcomingSoon]);
    expect(hero).toMatchObject({ state: "recap", event: { id: "evt-recent" } });
  });

  it("no active event → recap with the most recently ended event", () => {
    const hero = selectHero(null, [endedRecent, endedOld]);
    expect(hero).toMatchObject({ state: "recap", event: { id: "evt-recent" } });
  });

  it("no active and nothing ended → none", () => {
    expect(selectHero(null, [upcomingSoon])).toEqual({ state: "none" });
    expect(selectHero("evt-ghost", [])).toEqual({ state: "none" });
  });

  it("strips table keys off the hero event card", () => {
    const hero = selectHero("evt-live", [live]);
    expect(hero.state).toBe("live");
    if (hero.state === "live") {
      expect((hero.event as Record<string, unknown>)["PK"]).toBeUndefined();
    }
  });
});

describe("sortEvents (events tab ordering)", () => {
  it("orders live → upcoming (soonest first) → ended (most recent first)", () => {
    const sorted = sortEvents([endedOld, upcomingLater, endedRecent, live, upcomingSoon]);
    expect(sorted.map((e) => e["id"])).toEqual([
      "evt-live",
      "evt-soon",
      "evt-later",
      "evt-recent",
      "evt-old",
    ]);
  });

  it("does not mutate its input", () => {
    const input = [endedOld, live];
    sortEvents(input);
    expect(input.map((e) => e["id"])).toEqual(["evt-old", "evt-live"]);
  });
});

describe("rotateByMinute (bias-free entry rotation)", () => {
  const items = ["a", "b", "c", "d"];

  it("minute 0 keeps the stored order", () => {
    expect(rotateByMinute(items, 0)).toEqual(["a", "b", "c", "d"]);
  });

  it("rotates by minute % length", () => {
    expect(rotateByMinute(items, 1)).toEqual(["b", "c", "d", "a"]);
    expect(rotateByMinute(items, 3)).toEqual(["d", "a", "b", "c"]);
  });

  it("wraps when the minute exceeds the length", () => {
    expect(rotateByMinute(items, 6)).toEqual(["c", "d", "a", "b"]);
    expect(rotateByMinute(items, 4)).toEqual(["a", "b", "c", "d"]);
  });

  it("handles the empty list", () => {
    expect(rotateByMinute([], 42)).toEqual([]);
  });
});

describe("mapUserPartition (/v1/me row mapping)", () => {
  const meta = {
    PK: "USER#u-1",
    SK: "META",
    id: "u-1",
    name: "Test Fan",
    email: "fan@example.com",
    role: "fan",
    is18plus: true,
    pushEnabled: false,
    createdAt: "2026-07-01T00:00:00Z",
  };

  it("maps META, FOLLOW#, LIKE#, VOTE# and NOTIF# rows into the MeResponse shape", () => {
    const body = mapUserPartition("u-1", [
      meta,
      { PK: "USER#u-1", SK: "FOLLOW#ath-camila-garza" },
      { PK: "USER#u-1", SK: "FOLLOW#ath-jordan-banks" },
      { PK: "USER#u-1", SK: "VOTE#evt-nilstar-s1", entryId: "ent-camila" },
      { PK: "USER#u-1", SK: "NOTIF#channel#ch-trueblue" },
      { PK: "USER#u-1", SK: "NOTIF#ambassador#ath-maya-robinson" },
      { PK: "USER#u-1", SK: "LIKE#c-floor-routine" },
      { PK: "USER#u-1", SK: "LIKE#c-audition-camila" },
      // Rows the mapping must ignore: devices.
      { PK: "USER#u-1", SK: "DEVICE#tok-1" },
    ]);

    expect(body).toEqual({
      userId: "u-1",
      name: "Test Fan",
      email: "fan@example.com",
      role: "fan",
      is18plus: true,
      pushEnabled: false,
      votes: { "evt-nilstar-s1": "ent-camila" },
      follows: ["ath-camila-garza", "ath-jordan-banks"],
      likes: ["c-floor-routine", "c-audition-camila"],
      notificationFollows: [
        { targetType: "channel", targetId: "ch-trueblue" },
        { targetType: "ambassador", targetId: "ath-maya-robinson" },
      ],
    });
  });

  it("returns undefined when the META row is absent", () => {
    expect(mapUserPartition("u-1", [{ PK: "USER#u-1", SK: "FOLLOW#ath-x" }])).toBeUndefined();
    expect(mapUserPartition("u-1", [])).toBeUndefined();
  });

  it("keeps '#' inside a NOTIF targetId and skips unknown target types", () => {
    const body = mapUserPartition("u-1", [
      meta,
      { PK: "USER#u-1", SK: "NOTIF#school#duke#blue-devils" },
      { PK: "USER#u-1", SK: "NOTIF#bogus#whatever" },
    ]);
    expect(body?.notificationFollows).toEqual([
      { targetType: "school", targetId: "duke#blue-devils" },
    ]);
  });

  it("skips vote rows without an entryId instead of failing the whole read", () => {
    const body = mapUserPartition("u-1", [meta, { PK: "USER#u-1", SK: "VOTE#evt-x" }]);
    expect(body?.votes).toEqual({});
  });
});

describe("resolvePlaybackUrl / resolveThumbUrl (design §6.8 URL composition)", () => {
  beforeEach(() => {
    delete process.env.PLAYBACK_BASE_URL;
  });
  afterEach(() => {
    delete process.env.PLAYBACK_BASE_URL;
  });

  it("passes a stored absolute URL through untouched (fixtures/embeds)", () => {
    process.env.PLAYBACK_BASE_URL = "https://cdn.example.com";
    const row = { playbackUrl: "https://youtu.be/xyz", playbackPath: "/video/c-1/index.m3u8" };
    expect(resolvePlaybackUrl(row)).toBe("https://youtu.be/xyz");
  });

  it("composes base + path for pipeline rows", () => {
    process.env.PLAYBACK_BASE_URL = "https://cdn.example.com";
    const row = { playbackPath: "/video/c-1/index.m3u8", thumbPath: "/video/c-1/poster.0000000.jpg" };
    expect(resolvePlaybackUrl(row)).toBe("https://cdn.example.com/video/c-1/index.m3u8");
    expect(resolveThumbUrl(row)).toBe("https://cdn.example.com/video/c-1/poster.0000000.jpg");
  });

  it("is undefined when only a path exists but no base URL is configured", () => {
    expect(resolvePlaybackUrl({ playbackPath: "/video/c-1/index.m3u8" })).toBeUndefined();
  });

  it("is undefined when the row has neither URL nor path (not playable)", () => {
    process.env.PLAYBACK_BASE_URL = "https://cdn.example.com";
    expect(resolvePlaybackUrl({})).toBeUndefined();
    expect(resolveThumbUrl({})).toBeUndefined();
  });
});

describe("resolveEventMedia (event media, design §6.8)", () => {
  const showcaseRow = () => ({
    id: "evt-nilstar-s1",
    showcase: {
      heading: "Crowned July 2026",
      winner: {
        name: "Bella Calvanese",
        videoPath: "/video/brand/recap-s1/winner.mp4",
        posterPath: "/video/brand/recap-s1/winner.jpg",
      },
      finalists: [
        { name: "Simon Lioznyansky", photoPath: "/video/brand/recap-s1/simon-lioznyansky.jpg" },
        { name: "Mia Girgis", photoPath: "/video/brand/recap-s1/mia-girgis.jpg" },
      ],
    },
  });

  beforeEach(() => {
    delete process.env.PLAYBACK_BASE_URL;
  });
  afterEach(() => {
    delete process.env.PLAYBACK_BASE_URL;
  });

  it("composes winner and finalist URLs from the stage's base", () => {
    process.env.PLAYBACK_BASE_URL = "https://cdn.example.com";
    const out = resolveEventMedia(showcaseRow());
    const showcase = out["showcase"] as Record<string, any>;
    expect(showcase["winner"].videoUrl).toBe("https://cdn.example.com/video/brand/recap-s1/winner.mp4");
    expect(showcase["winner"].posterUrl).toBe("https://cdn.example.com/video/brand/recap-s1/winner.jpg");
    expect(showcase["finalists"].map((f: any) => f.photoUrl)).toEqual([
      "https://cdn.example.com/video/brand/recap-s1/simon-lioznyansky.jpg",
      "https://cdn.example.com/video/brand/recap-s1/mia-girgis.jpg",
    ]);
    // Names and headings ride through untouched.
    expect(showcase["heading"]).toBe("Crowned July 2026");
    expect(showcase["winner"].name).toBe("Bella Calvanese");
  });

  it("leaves URLs undefined when no base is configured (never emits a bare path)", () => {
    const showcase = resolveEventMedia(showcaseRow())["showcase"] as Record<string, any>;
    expect(showcase["winner"].videoUrl).toBeUndefined();
    expect(showcase["finalists"][0].photoUrl).toBeUndefined();
  });

  it("passes a stored absolute URL through untouched", () => {
    process.env.PLAYBACK_BASE_URL = "https://cdn.example.com";
    const row = {
      showcase: {
        heading: "h",
        winner: { name: "W", videoUrl: "https://youtu.be/xyz", videoPath: "/video/brand/x.mp4" },
        finalists: [],
      },
    };
    const showcase = resolveEventMedia(row)["showcase"] as Record<string, any>;
    expect(showcase["winner"].videoUrl).toBe("https://youtu.be/xyz");
  });

  it("passes rows without a showcase straight through", () => {
    const row = { id: "evt-nilteststar-s1", title: "NIL Test Star" };
    expect(resolveEventMedia(row)).toEqual(row);
  });

  it("composes the intro reel URL on rows without a showcase", () => {
    process.env.PLAYBACK_BASE_URL = "https://cdn.example.com";
    const row = { id: "evt-rap", introVideoPath: "/video/brand/teststar-intro.mp4" };
    expect(resolveEventMedia(row)["introVideoUrl"]).toBe(
      "https://cdn.example.com/video/brand/teststar-intro.mp4",
    );
  });
});

describe("encodeCursor / decodeCursor (opaque pagination)", () => {
  it("round-trips a LastEvaluatedKey", () => {
    const key = { PK: "CONTENT#c-1", SK: "META", GSI1PK: "CHANNEL#ch-niltv", GSI1SK: "2026-07-13T12:00:00Z" };
    expect(decodeCursor(encodeCursor(key))).toEqual(key);
  });

  it("is undefined for a missing key or cursor", () => {
    expect(encodeCursor(undefined)).toBeUndefined();
    expect(decodeCursor(undefined)).toBeUndefined();
  });

  it("is undefined for malformed cursors instead of throwing", () => {
    expect(decodeCursor("not-base64-json")).toBeUndefined();
    expect(decodeCursor(Buffer.from("[1,2]").toString("base64url"))).toBeUndefined();
    expect(decodeCursor(Buffer.from("42").toString("base64url"))).toBeUndefined();
  });
});

describe("directoryChips (/v1/profiles)", () => {
  const profile = (id: string, statuses: string[], ambassadorRank?: number) => ({
    PK: `ATHLETE#${id}`,
    SK: "META",
    id,
    name: `Name ${id}`,
    school: "Duke",
    sport: "Lacrosse",
    statuses,
    ...(ambassadorRank !== undefined ? { ambassadorRank } : {}),
  });

  const rows = [
    profile("ath-rank1", ["athlete", "ambassador"], 1),
    profile("ath-rank2", ["athlete", "ambassador"], 2),
    profile("ath-plain", ["athlete"]),
    profile("ath-unranked-amb", ["athlete", "ambassador"]),
  ];

  it("returns everyone in stored order without the filter", () => {
    const chips = directoryChips(rows, false);
    expect(chips.map((c) => c.id)).toEqual(["ath-rank1", "ath-rank2", "ath-plain", "ath-unranked-amb"]);
    expect(chips.map((c) => c.isAmbassador)).toEqual([true, true, false, true]);
  });

  it("ambassador filter keeps only ambassadors, rank ascending, unranked last", () => {
    const chips = directoryChips([...rows].reverse(), true);
    expect(chips.map((c) => c.id)).toEqual(["ath-rank1", "ath-rank2", "ath-unranked-amb"]);
  });

  it("strips table keys off the chips", () => {
    const chip = directoryChips(rows, false)[0] as Record<string, unknown>;
    expect(chip["PK"]).toBeUndefined();
    expect(chip["GSI1PK"]).toBeUndefined();
  });
});
