import { describe, expect, it } from "vitest";

import { AUDITION_IDS, finalistTitle, SEASON1_FINALISTS } from "./competitions";

describe("SEASON1_FINALISTS", () => {
  it("is the site's full Top 20, in announcement order", () => {
    expect(SEASON1_FINALISTS).toHaveLength(20);
    expect(SEASON1_FINALISTS[0]).toEqual({
      id: "ig-18090687326638212",
      name: "Bella Calvanese",
      champion: true,
    });
    expect(SEASON1_FINALISTS[1]?.name).toBe("Taylee Chirrick");
    expect(SEASON1_FINALISTS[19]).toEqual({ id: "ig-17960395157963864", name: "Simon Lioznyansky" });
  });

  it("flags exactly one champion, first", () => {
    const champions = SEASON1_FINALISTS.filter((f) => f.champion);
    expect(champions).toHaveLength(1);
    expect(champions[0]).toBe(SEASON1_FINALISTS[0]);
  });

  it("has no duplicate ids and every id is an ig- content id", () => {
    const ids = SEASON1_FINALISTS.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^ig-\d+$/);
  });
});

describe("AUDITION_IDS", () => {
  it("is the site's 24-card rail, promo first, Jaylin Lott's original last", () => {
    expect(AUDITION_IDS).toHaveLength(24);
    expect(AUDITION_IDS[0]).toBe("ig-18539419810078105");
    expect(AUDITION_IDS[12]).toBe("ig-17959556736138023");
    expect(AUDITION_IDS[13]).toBe("ig-18166221412439513");
    expect(AUDITION_IDS[23]).toBe("ig-18594161446025211");
  });

  it("has no duplicates and shares no id with the Season 1 shelf", () => {
    expect(new Set(AUDITION_IDS).size).toBe(AUDITION_IDS.length);
    const finalists = new Set(SEASON1_FINALISTS.map((f) => f.id));
    for (const id of AUDITION_IDS) expect(finalists.has(id)).toBe(false);
  });
});

describe("finalistTitle", () => {
  it("is the plain name for everyone, champion included (the site hides tile tags)", () => {
    expect(finalistTitle({ id: "x", name: "Taylee Chirrick" })).toBe("Taylee Chirrick");
    expect(finalistTitle({ id: "x", name: "Bella Calvanese", champion: true })).toBe("Bella Calvanese");
  });
});
