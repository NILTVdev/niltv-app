import { describe, expect, it } from "vitest";

import { CATEGORY_RAILS, RAIL_FLOOR, categoryRailsFor } from "./categoryRails";

const TIMELESS = [
  "Music",
  "Romance",
  "Competitions",
  "Comedy",
  "Food",
  "Style",
  "Home",
  "Games",
  "Storytelling",
  "Transformations",
  "Relationships",
  "BTS",
  "Community",
];

describe("CATEGORY_RAILS", () => {
  it("is the site's category shelves, in timeless-category order, each within the site's rail bounds", () => {
    // Which categories show moves with every sync (a thin one appears once it
    // fills), so assert order and bounds, not today's list.
    const titles = CATEGORY_RAILS.map((r) => r.title);
    expect(titles.length).toBeGreaterThan(0);
    for (const t of titles) expect(TIMELESS).toContain(t);
    expect([...titles].sort((a, b) => TIMELESS.indexOf(a) - TIMELESS.indexOf(b))).toEqual(titles);
    for (const r of CATEGORY_RAILS) {
      expect(r.cards.length).toBeGreaterThanOrEqual(RAIL_FLOOR);
      expect(r.cards.length).toBeLessThanOrEqual(24);
    }
  });

  it("never carries the site's other homepage shelves", () => {
    for (const r of CATEGORY_RAILS) {
      expect(["Trending on NIL TV", "Sponsored Content", "NIL Singing Star Season 1"]).not.toContain(r.title);
    }
  });

  it("shows each clip once across all category rails, with a decoded, non-empty title", () => {
    const ids = new Set<string>();
    let cards = 0;
    for (const r of CATEGORY_RAILS) {
      for (const c of r.cards) {
        expect(c.id).toMatch(/^(ig|tbtv)-/);
        expect(c.title.length).toBeGreaterThan(0);
        expect(c.title).not.toMatch(/&[a-z#0-9]+;/i);
        ids.add(c.id);
        cards += 1;
      }
    }
    expect(ids.size).toBe(cards);
  });
});

describe("categoryRailsFor", () => {
  const rail = (title: string, n: number, prefix = title) => ({
    title,
    cards: Array.from({ length: n }, (_, i) => ({ id: `ig-${prefix}${i}`, title: `${title} ${i}` })),
  });

  it("drops clips already claimed above the categories, keeping rail order", () => {
    const out = categoryRailsFor(new Set(["ig-a0", "ig-b3"]), [rail("Music", 10, "a"), rail("Food", 10, "b")]);
    expect(out.map((r) => r.title)).toEqual(["Music", "Food"]);
    expect(out[0]?.cards.map((c) => c.id)).not.toContain("ig-a0");
    expect(out[1]?.cards).toHaveLength(9);
  });

  it("hides a rail that falls under the floor once claimed clips are gone", () => {
    const out = categoryRailsFor(new Set(["ig-a0", "ig-a1"]), [rail("Music", 9, "a"), rail("Food", 8, "b")]);
    expect(out.map((r) => r.title)).toEqual(["Food"]);
  });

  it("passes every synced rail through untouched when nothing is claimed", () => {
    expect(categoryRailsFor(new Set())).toEqual(CATEGORY_RAILS);
  });
});
