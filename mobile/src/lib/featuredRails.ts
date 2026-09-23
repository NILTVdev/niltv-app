/**
 * The Featured tab's curated rails, mirrored from the site's /featured/
 * page. The ids and captions come from featuredRails.generated.json, which
 * scripts/sync-featured-rails.mjs writes from the built
 * webapp/featured/index.html. Re-run that script before every OTA publish;
 * the site rebakes its shelves on each web deploy.
 *
 * The site's first shelf ("New This Week", or "Latest on the Network" when
 * fewer than four clips are a week old) is NOT in here: the app builds it
 * live off /v1/home in lib/newThisWeek.ts.
 */
import generated from "./featuredRails.generated.json";

export interface FeaturedRailCard {
  id: string;
  /** The site's reel caption, already shortened by the site builder. */
  title: string;
}

export interface FeaturedRail {
  title: string;
  cards: FeaturedRailCard[];
}

export interface FeaturedRailsFile {
  syncedFrom: string;
  rails: FeaturedRail[];
}

const file: FeaturedRailsFile = generated;

/** The site's curated shelves, in site order. */
export const FEATURED_RAILS: FeaturedRail[] = file.rails;

/**
 * A clip's poster on the stage CDN. Every clip the site shelves (ig-* and
 * tbtv-* alike) has poster.jpg under the same key in both stage buckets, so
 * the caller passes its own cdn (config.apiBase).
 */
export function posterUrl(cdn: string, id: string): string {
  return `${cdn}/video/${id}/poster.jpg`;
}
