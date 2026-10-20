/**
 * Home's Timeless Category rails (Music, Competitions, Comedy, ...), mirrored
 * from the site's homepage. The ids and captions come from
 * categoryRails.generated.json, which scripts/sync-featured-rails.mjs writes
 * from the built webapp/index.html. Re-run that script before every OTA
 * publish so Home matches niltv.com.
 *
 * The site already hides a category under its eight-clip floor and never
 * repeats a clip across category rails. Home adds one rule of its own: a clip
 * the hero or a rail above the categories already shows is skipped, and a
 * category that drops under the floor after that stays hidden.
 */
import type { FeaturedRail, FeaturedRailsFile } from "./featuredRails";
import generated from "./categoryRails.generated.json";

const file: FeaturedRailsFile = generated;

/** The site's category shelves, in site order. */
export const CATEGORY_RAILS: FeaturedRail[] = file.rails;

/** The site's editorial floor: a carousel never shows with fewer cards. */
export const RAIL_FLOOR = 8;

/**
 * The category rails Home renders: `claimed` ids (hero slides and the rails
 * above) dropped, then any rail left under the floor dropped.
 */
export function categoryRailsFor(
  claimed: ReadonlySet<string>,
  rails: readonly FeaturedRail[] = CATEGORY_RAILS,
  floor: number = RAIL_FLOOR,
): FeaturedRail[] {
  return rails
    .map((r) => ({ title: r.title, cards: r.cards.filter((c) => !claimed.has(c.id)) }))
    .filter((r) => r.cards.length >= floor);
}
