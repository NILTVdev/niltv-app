/**
 * Campus channel "live vs Coming Soon", mirrored from the web builder
 * (webapp/scripts/builders/build-sections.py). A campus channel is live once
 * it carries CAMPUS_LIVE_MIN clips; under that the site renders an unlinked
 * Coming Soon tile and the Channels tab follows suit. The count is the
 * channel's own clipCount from GET /v1/channels (one GSI1 COUNT per
 * channel), so the rule is exact for every roster channel and has no Home
 * dependency. Kept pure (no react-native) so the rule is unit-testable;
 * Brand.tsx re-exports the constants beside NETWORK_SOURCES for the screens.
 */
import type { Channel } from "@niltv/types";

/** build-sections.py COMING_SOON_MIN = 6. */
export const CAMPUS_LIVE_MIN = 6;

/**
 * build-sections.py GRID_REMOVED = brazos + goldsalem: off the channels grid
 * for now. A hand-set list, not derived from clip counts; the
 * floor above only decides the caption.
 */
export const CHANNELS_GRID_HIDDEN = new Set(["ch-brazostv", "ch-goldsalemtv"]);

/**
 * Coming Soon only when the channel reports a count under the floor. An
 * unknown count (fixtures, an older backend that sends no clipCount) stays
 * live, so the mobile JS can ship ahead of an api deploy without disabling a
 * channel.
 */
export function isComingSoon(channel: Pick<Channel, "clipCount">, min = CAMPUS_LIVE_MIN): boolean {
  return channel.clipCount !== undefined && channel.clipCount < min;
}

/**
 * The web channel wall order (build-sections.py CHAN_TILES): TrueBlue TV
 * leads, then the roster in site order. The Channels tab sorts the
 * /v1/channels roster by this list before its live/Coming Soon split, so the
 * carousel and the shelves read the same as the site.
 */
export const CAMPUS_CHANNEL_ORDER: readonly string[] = [
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
];

/**
 * A copy of `channels` sorted by CAMPUS_CHANNEL_ORDER. Ids not on the list
 * (a channel minted after this file, a legacy id) trail the known ones in
 * their input order; the sort is stable, so duplicates keep their order too.
 */
export function rosterOrder<T extends { id: string }>(channels: readonly T[]): T[] {
  const rank = (c: T) => {
    const i = CAMPUS_CHANNEL_ORDER.indexOf(c.id);
    return i === -1 ? CAMPUS_CHANNEL_ORDER.length : i;
  };
  return [...channels].sort((a, b) => rank(a) - rank(b));
}
