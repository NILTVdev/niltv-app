import type { Channel } from "@niltv/types";
import { describe, expect, it } from "vitest";

import { CAMPUS_CHANNEL_ORDER, CAMPUS_LIVE_MIN, CHANNELS_GRID_HIDDEN, isComingSoon, rosterOrder } from "./channelLive";

describe("isComingSoon", () => {
  it("keeps a channel with no count live (fixtures, an older backend)", () => {
    expect(isComingSoon({})).toBe(false);
    expect(isComingSoon({ clipCount: undefined })).toBe(false);
  });

  it("is Coming Soon under the floor", () => {
    // An empty channel is Coming Soon.
    expect(isComingSoon({ clipCount: 0 })).toBe(true);
    expect(isComingSoon({ clipCount: CAMPUS_LIVE_MIN - 1 })).toBe(true);
  });

  it("is live at the floor and above", () => {
    // Exactly on the floor counts as live.
    expect(isComingSoon({ clipCount: CAMPUS_LIVE_MIN })).toBe(false);
    expect(isComingSoon({ clipCount: 273 })).toBe(false);
  });

  it("honours a custom floor", () => {
    expect(isComingSoon({ clipCount: 3 }, 3)).toBe(false);
    expect(isComingSoon({ clipCount: 3 }, 4)).toBe(true);
  });

  it("takes a full channel and reads only its clipCount", () => {
    const goldenDome: Channel = { id: "ch-goldendometv", name: "Golden Dome TV", kind: "campus", clipCount: 0 };
    const starkville: Channel = { id: "ch-starkvilletv", name: "Starkville TV", kind: "campus", clipCount: 6 };
    const older: Channel = { id: "ch-truebluetv", name: "TrueBlue TV", kind: "campus" };
    expect(isComingSoon(goldenDome)).toBe(true);
    expect(isComingSoon(starkville)).toBe(false);
    expect(isComingSoon(older)).toBe(false);
  });
});

describe("CAMPUS_LIVE_MIN", () => {
  it("mirrors the web builder's COMING_SOON_MIN = 6", () => {
    expect(CAMPUS_LIVE_MIN).toBe(6);
  });
});

describe("CHANNELS_GRID_HIDDEN", () => {
  it("mirrors the web builder's GRID_REMOVED (brazos + goldsalem)", () => {
    expect(CHANNELS_GRID_HIDDEN).toEqual(new Set(["ch-brazostv", "ch-goldsalemtv"]));
    expect(CHANNELS_GRID_HIDDEN.has("ch-starkvilletv")).toBe(false);
  });
});

describe("CAMPUS_CHANNEL_ORDER", () => {
  it("mirrors the web channel wall (build-sections.py CHAN_TILES) with TrueBlue TV first", () => {
    expect(CAMPUS_CHANNEL_ORDER[0]).toBe("ch-truebluetv");
    expect(CAMPUS_CHANNEL_ORDER).toEqual([
      "ch-truebluetv",
      "ch-dorecitytv",
      "ch-chapelhilltv",
      "ch-starkvilletv",
      "ch-collegestationtv",
      "ch-brazostv",
      "ch-goldendometv",
      "ch-redpacktv",
      "ch-saltcitytv",
      "ch-goldsalemtv",
    ]);
    expect(new Set(CAMPUS_CHANNEL_ORDER).size).toBe(CAMPUS_CHANNEL_ORDER.length);
  });
});

describe("rosterOrder", () => {
  const ch = (id: string, clipCount?: number): Channel => ({ id, name: id, kind: "campus", clipCount });

  it("applies the site order whatever the API order was", () => {
    const api = [ch("ch-starkvilletv", 6), ch("ch-chapelhilltv", 13), ch("ch-truebluetv", 273), ch("ch-dorecitytv", 40)];
    expect(rosterOrder(api).map((c) => c.id)).toEqual([
      "ch-truebluetv", "ch-dorecitytv", "ch-chapelhilltv", "ch-starkvilletv",
    ]);
  });

  it("returns a copy and leaves the input alone", () => {
    const api = [ch("ch-dorecitytv"), ch("ch-truebluetv")];
    const sorted = rosterOrder(api);
    expect(sorted).not.toBe(api);
    expect(api.map((c) => c.id)).toEqual(["ch-dorecitytv", "ch-truebluetv"]);
    expect(sorted.map((c) => c.id)).toEqual(["ch-truebluetv", "ch-dorecitytv"]);
  });

  it("trails unknown ids after the known ones, in their input order", () => {
    const api = [ch("ch-newtv"), ch("ch-dorecitytv"), ch("ch-trueblue"), ch("ch-truebluetv"), ch("ch-othertv")];
    expect(rosterOrder(api).map((c) => c.id)).toEqual([
      "ch-truebluetv", "ch-dorecitytv", "ch-newtv", "ch-trueblue", "ch-othertv",
    ]);
  });

  it("is stable for duplicate ids", () => {
    const first = ch("ch-dorecitytv", 1);
    const second = ch("ch-dorecitytv", 2);
    const sorted = rosterOrder([second, ch("ch-truebluetv"), first]);
    expect(sorted[0]?.id).toBe("ch-truebluetv");
    expect(sorted[1]).toBe(second);
    expect(sorted[2]).toBe(first);
  });

  it("handles an empty roster", () => {
    expect(rosterOrder([])).toEqual([]);
  });

  it("keeps the element type (works on a narrower shape than Channel)", () => {
    const sorted = rosterOrder([{ id: "ch-saltcitytv", extra: 1 }, { id: "ch-truebluetv", extra: 2 }]);
    expect(sorted.map((c) => c.extra)).toEqual([2, 1]);
  });
});
