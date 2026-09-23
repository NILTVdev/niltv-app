import { describe, expect, it } from "vitest";

import { MARQUEE_ROW_A, MARQUEE_ROW_B, marqueePosterUrl } from "./marquee";

describe("marqueePosterUrl", () => {
  it("points at the stage's poster for the id", () => {
    expect(marqueePosterUrl("https://d1nm1d2txb83wa.cloudfront.net", "ig-18275620366295532")).toBe(
      "https://d1nm1d2txb83wa.cloudfront.net/video/ig-18275620366295532/poster.jpg",
    );
  });

  it("keeps the tbtv archive ids as they are (hyphens and all)", () => {
    expect(marqueePosterUrl("https://cdn", "tbtv-DYnsMfYsQQ-")).toBe("https://cdn/video/tbtv-DYnsMfYsQQ-/poster.jpg");
  });
});

describe("marquee rows", () => {
  it("mirror the site's chmq rows (9 + 12, site order)", () => {
    expect(MARQUEE_ROW_A).toHaveLength(9);
    expect(MARQUEE_ROW_B).toHaveLength(12);
    expect(MARQUEE_ROW_A[0]).toBe("ig-18275620366295532");
    expect(MARQUEE_ROW_A[8]).toBe("ig-18026514830905320");
    expect(MARQUEE_ROW_B[0]).toBe("ig-17902243089530973");
    expect(MARQUEE_ROW_B[11]).toBe("tbtv-DYfPCxLCZf1");
  });

  it("has no duplicate within a row (the loop repeats the row, not the ids)", () => {
    expect(new Set(MARQUEE_ROW_A).size).toBe(MARQUEE_ROW_A.length);
    expect(new Set(MARQUEE_ROW_B).size).toBe(MARQUEE_ROW_B.length);
  });

  it("every id is a content id shape the CDN serves", () => {
    for (const id of [...MARQUEE_ROW_A, ...MARQUEE_ROW_B]) {
      expect(id).toMatch(/^(ig-\d+|tbtv-[\w-]+)$/);
    }
  });
});
