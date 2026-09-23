import type { ContentCard, Rail } from "@niltv/types";
import { describe, expect, it } from "vitest";

import { newThisWeek } from "./newThisWeek";

const NOW = new Date("2026-09-08T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

function card(id: string, daysAgo: number | null, channelId = "ch-niltv"): ContentCard {
  return {
    id,
    title: id,
    channelId,
    channelName: channelId,
    creatorId: "p-1",
    creatorName: "Someone",
    creatorIsAmbassador: false,
    ...(daysAgo === null ? {} : { publishedAt: new Date(NOW.getTime() - daysAgo * DAY).toISOString() }),
  };
}

function rail(key: string, items: ContentCard[]): Rail {
  return { kind: "content", key, title: key, items };
}

describe("newThisWeek", () => {
  it("titles New This Week when four or more clips are a week old or newer, newest first", () => {
    const shelf = newThisWeek(
      [
        rail("network", [card("a", 1), card("b", 6), card("c", 30)]),
        rail("campus", [card("d", 0.5), card("e", 3), card("f", 10)]),
      ],
      NOW,
    );
    expect(shelf.title).toBe("New This Week");
    expect(shelf.cards.map((c) => c.id)).toEqual(["d", "a", "e", "b"]);
  });

  it("falls back to Latest on the Network with the newest of the whole pool when fewer than four are fresh", () => {
    const shelf = newThisWeek(
      [rail("network", [card("a", 1), card("b", 20), card("c", 9), card("d", 40), card("e", 2)])],
      NOW,
    );
    expect(shelf.title).toBe("Latest on the Network");
    expect(shelf.cards.map((c) => c.id)).toEqual(["a", "e", "c", "b", "d"]);
  });

  it("never shelves NIL Star clips, in either branch", () => {
    const star = [card("s1", 0, "ch-nilstar"), card("s2", 1, "ch-nilstar"), card("s3", 1, "ch-nilstar")];
    const fresh = newThisWeek(
      [rail("nilstar", star), rail("network", [card("a", 1), card("b", 2), card("c", 3), card("d", 4)])],
      NOW,
    );
    expect(fresh.title).toBe("New This Week");
    expect(fresh.cards.map((c) => c.id)).toEqual(["a", "b", "c", "d"]);

    const stale = newThisWeek([rail("nilstar", star), rail("network", [card("a", 30)])], NOW);
    expect(stale.title).toBe("Latest on the Network");
    expect(stale.cards.map((c) => c.id)).toEqual(["a"]);
  });

  it("dedupes a clip that sits in more than one rail and skips athlete rails", () => {
    const athletes: Rail = {
      kind: "athletes",
      key: "ambassadors",
      title: "Ambassadors",
      items: [{ id: "p-1", name: "Someone", school: "Duke", sport: "Rowing", isAmbassador: true }],
    };
    const shelf = newThisWeek(
      [rail("network", [card("a", 1)]), rail("trending", [card("a", 1), card("b", 2)]), athletes],
      NOW,
      1,
    );
    expect(shelf.cards.map((c) => c.id)).toEqual(["a", "b"]);
  });

  it("treats a missing publishedAt as oldest and caps the shelf at size", () => {
    const items = [card("none", null), ...Array.from({ length: 15 }, (_, i) => card(`c${i}`, i * 0.1))];
    const shelf = newThisWeek([rail("network", items)], NOW, 4, 12);
    expect(shelf.title).toBe("New This Week");
    expect(shelf.cards).toHaveLength(12);
    expect(shelf.cards.some((c) => c.id === "none")).toBe(false);

    const few = newThisWeek([rail("network", [card("none", null), card("old", 60)])], NOW, 4, 12);
    expect(few.title).toBe("Latest on the Network");
    expect(few.cards.map((c) => c.id)).toEqual(["old", "none"]);
  });
});
