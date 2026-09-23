import { describe, expect, it } from "vitest";

import { FEATURED_RAILS, posterUrl } from "./featuredRails";

describe("FEATURED_RAILS", () => {
  it("is the site's curated shelves, in site order, each filled within the site's rail bounds", () => {
    // Counts move with every sync (the site rebakes shelves per deploy), so
    // assert shape, not today's numbers.
    expect(FEATURED_RAILS.map((r) => r.title)).toEqual(["Media Day", "Gear Drops", "Day in the Life"]);
    for (const r of FEATURED_RAILS) {
      expect(r.cards.length).toBeGreaterThan(0);
      expect(r.cards.length).toBeLessThanOrEqual(24);
    }
  });

  it("never carries the live shelf (the app builds New This Week itself)", () => {
    for (const r of FEATURED_RAILS) {
      expect(r.title).not.toBe("New This Week");
      expect(r.title).not.toBe("Latest on the Network");
    }
  });

  it("has a unique id and a decoded, non-empty title on every card", () => {
    const keys = new Set<string>();
    for (const r of FEATURED_RAILS) {
      for (const c of r.cards) {
        expect(c.id).toMatch(/^(ig|tbtv)-/);
        expect(c.title.length).toBeGreaterThan(0);
        // Captions are decoded text, never raw HTML entities.
        expect(c.title).not.toMatch(/&[a-z#0-9]+;/i);
        keys.add(`${r.title}:${c.id}`);
      }
    }
    expect(keys.size).toBe(FEATURED_RAILS.reduce((n, r) => n + r.cards.length, 0));
  });
});

describe("posterUrl", () => {
  it("is the clip's poster.jpg under the given cdn, for ig and tbtv ids alike", () => {
    expect(posterUrl("https://cdn.example.test", "ig-18015379163731306")).toBe(
      "https://cdn.example.test/video/ig-18015379163731306/poster.jpg",
    );
    expect(posterUrl("https://prod.example.test", "tbtv-DRfoMpuEp7B")).toBe(
      "https://prod.example.test/video/tbtv-DRfoMpuEp7B/poster.jpg",
    );
  });
});
