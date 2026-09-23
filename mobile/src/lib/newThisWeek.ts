/**
 * The Featured tab's live first shelf: the site's "New This Week" rule
 * (webapp/scripts/builders/themed_rails.py) run over /v1/home instead of the
 * site build. The network's newest clips no more than seven days old across
 * NIL TV and the campus channels, never NIL Star. When fewer than four
 * qualify the shelf keeps its size and retitles to "Latest on the Network",
 * as the site does. Pure, so the screen stays thin.
 *
 * The TrueBlue TV rail is on /v1/home, so its clips pool here too.
 * That matches the site, whose network_latest pulls every channel but NIL
 * Star (build-sections.py); nothing here excludes it on purpose.
 */
import type { ContentCard, Rail } from "@niltv/types";

export const FRESH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** NIL Star clips never shelve here, on the site or in the app. */
export const NILSTAR_CHANNEL_ID = "ch-nilstar";

export interface NewThisWeekShelf {
  title: "New This Week" | "Latest on the Network";
  cards: ContentCard[];
}

/** Epoch ms of a card's publish time; a missing or bad stamp sorts oldest. */
function publishedMs(card: ContentCard): number {
  if (!card.publishedAt) return Number.MIN_SAFE_INTEGER;
  const ms = Date.parse(card.publishedAt);
  return Number.isNaN(ms) ? Number.MIN_SAFE_INTEGER : ms;
}

export function newThisWeek(rails: Rail[], now: Date, minFresh = 4, size = 12): NewThisWeekShelf {
  const seen = new Set<string>();
  const pool: ContentCard[] = [];
  for (const rail of rails) {
    if (rail.kind !== "content") continue;
    for (const card of rail.items) {
      if (card.channelId === NILSTAR_CHANNEL_ID || seen.has(card.id)) continue;
      seen.add(card.id);
      pool.push(card);
    }
  }
  pool.sort((a, b) => publishedMs(b) - publishedMs(a));

  const cutoff = now.getTime() - FRESH_WINDOW_MS;
  const fresh = pool.filter((card) => publishedMs(card) >= cutoff);
  if (fresh.length >= minFresh) {
    return { title: "New This Week", cards: fresh.slice(0, size) };
  }
  return { title: "Latest on the Network", cards: pool.slice(0, size) };
}
