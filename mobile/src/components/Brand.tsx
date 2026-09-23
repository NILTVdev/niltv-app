import { Image, type ImageStyle, type StyleProp } from "react-native";

/**
 * Bundled brand marks (assets/brand). The header logo replaces the old
 * ★ + "NILTV" text; channel logos key off channel id.
 * Every file here is the one the site renders, copied from webapp/assets/img:
 * chan3/*.webp (stacked campus marks), chanh/*.webp (horizontal
 * lockups), nilstar-logo-wide.webp and niltv-logo.webp. Keep them .webp:
 * React Native decodes it on iOS 14+ and Android.
 *
 * Two channel-mark sets: CHANNEL_LOGOS (stacked chan3 art, used by the
 * Channels grid tiles) and CHANNEL_LOGOS_H (the 3:1 chanh lockups in
 * assets/brand/horiz, the channel screen's title via channelLogoH, as the
 * site's channel pages use them for h1.hero-title).
 */

const NILTV_LOGO = require("../../assets/brand/niltv-logo.webp");
const NILSTAR_LOGO = require("../../assets/brand/nilstar-logo.webp");

/**
 * Campus marks: the chan3 set (assets/brand/chan3, the stacked .webp files
 * the site's channels wall renders; goldsalem is the site's goldsalem2.webp,
 * its current Gold Salem). Transparent art drawn for the dark ground, so it
 * sits borderless on the network black. Exactly the ten roster channels;
 * anything else falls back to the text-name card.
 */
const TRUEBLUE_LOGO = require("../../assets/brand/chan3/trueblue.webp");

const CHANNEL_LOGOS: Record<string, number> = {
  "ch-niltv": NILTV_LOGO,
  "ch-nilstar": NILSTAR_LOGO,
  // The backend uses ch-truebluetv; keep ch-trueblue for older data.
  "ch-trueblue": TRUEBLUE_LOGO,
  "ch-truebluetv": TRUEBLUE_LOGO,
  "ch-chapelhilltv": require("../../assets/brand/chan3/chapelhill.webp"),
  "ch-dorecitytv": require("../../assets/brand/chan3/dorecity.webp"),
  "ch-starkvilletv": require("../../assets/brand/chan3/starkville.webp"),
  "ch-collegestationtv": require("../../assets/brand/chan3/collegestation.webp"),
  "ch-goldendometv": require("../../assets/brand/chan3/goldendome.webp"),
  "ch-redpacktv": require("../../assets/brand/chan3/redpack.webp"),
  "ch-brazostv": require("../../assets/brand/chan3/brazos.webp"),
  "ch-saltcitytv": require("../../assets/brand/chan3/saltcity.webp"),
  "ch-goldsalemtv": require("../../assets/brand/chan3/goldsalem.webp"),
};

export function channelLogo(channelId: string): number | undefined {
  return CHANNEL_LOGOS[channelId];
}

/**
 * Horizontal lockups (assets/brand/horiz, the site's chanh set, all 1000x333
 * so aspect 3:1). The channel screen renders one as its title in place of
 * the text name. Same ten roster channels as the stacked map.
 */
const TRUEBLUE_LOGO_H = require("../../assets/brand/horiz/trueblue.webp");

const CHANNEL_LOGOS_H: Record<string, number> = {
  // The backend uses ch-truebluetv; keep ch-trueblue for older data.
  "ch-trueblue": TRUEBLUE_LOGO_H,
  "ch-truebluetv": TRUEBLUE_LOGO_H,
  "ch-dorecitytv": require("../../assets/brand/horiz/dorecity.webp"),
  "ch-chapelhilltv": require("../../assets/brand/horiz/chapelhill.webp"),
  "ch-starkvilletv": require("../../assets/brand/horiz/starkville.webp"),
  "ch-collegestationtv": require("../../assets/brand/horiz/collegestation.webp"),
  "ch-goldendometv": require("../../assets/brand/horiz/goldendome.webp"),
  "ch-redpacktv": require("../../assets/brand/horiz/redpack.webp"),
  "ch-brazostv": require("../../assets/brand/horiz/brazos.webp"),
  "ch-saltcitytv": require("../../assets/brand/horiz/saltcity.webp"),
  "ch-goldsalemtv": require("../../assets/brand/horiz/goldsalem.webp"),
};

export function channelLogoH(channelId: string): number | undefined {
  return CHANNEL_LOGOS_H[channelId];
}

/**
 * School captions, the site's CHAN_CAPS (build-sections.py) word for word,
 * UNC included. Only schools the site itself captions; any
 * channel not listed here shows its channel name instead. Never guess a
 * school. The bare name must never reach the screen (the school naming
 * rule): channel surfaces render it through
 * `channelDescriptor()` below, person surfaces through `nilSchool()`.
 */
const CHANNEL_META: Record<string, { school: string }> = {
  "ch-trueblue": { school: "Duke" },
  "ch-truebluetv": { school: "Duke" },
  "ch-dorecitytv": { school: "Vanderbilt" },
  "ch-chapelhilltv": { school: "UNC" },
  "ch-starkvilletv": { school: "Mississippi State" },
  "ch-collegestationtv": { school: "Texas A&M" },
  "ch-goldsalemtv": { school: "Wake Forest" },
  "ch-saltcitytv": { school: "Syracuse" },
  // Also captioned by the site (build-sections.py).
  "ch-brazostv": { school: "Baylor" },
  "ch-goldendometv": { school: "Notre Dame" },
  "ch-redpacktv": { school: "NC State" },
};

export function channelSchool(channelId: string): string | undefined {
  return CHANNEL_META[channelId]?.school;
}

/**
 * The site's channel caption (.chan-cap): "{School}’s Athletes", typographic
 * apostrophe, one line. Every channel surface reads this to match the
 * website (Channels-tab tiles, the channel page dek, shelf captions); it
 * replaces the "{School} NIL Student Athletes" form there only.
 * Profile and person surfaces keep nilSchool() (docs/CONVENTIONS.md).
 */
export function channelDescriptor(channelId: string): string | undefined {
  const school = channelSchool(channelId);
  return school ? `${school}’s Athletes` : undefined;
}

/**
 * NIL TV and NIL Star are the network's own media + event sources, not campus
 * channels: they stay out of the Channels browser and the Home "Campus
 * Channels" break — even though the ingest bridge minted ch-nilstar with
 * kind "campus" (both stages), so kind alone cannot draw this line.
 */
export const NETWORK_SOURCES = new Set(["ch-niltv", "ch-nilstar"]);

/**
 * Campus roster rules, mirrored from the web builder
 * (webapp/scripts/builders/build-sections.py): COMING_SOON_MIN = 6
 * is CAMPUS_LIVE_MIN (a channel whose /v1/channels clipCount is under six is
 * Coming Soon; an unknown count stays live, see isComingSoon), and
 * GRID_REMOVED = brazos + goldsalem is CHANNELS_GRID_HIDDEN (off the Channels
 * grid for now). Defined in lib/channelLive, which stays free of react-native
 * so the rule is unit-tested; re-exported here beside NETWORK_SOURCES.
 */
export { CAMPUS_LIVE_MIN, CHANNELS_GRID_HIDDEN } from "@/lib/channelLive";

/**
 * Brand accent per channel, sampled from each channel's own logo art (the
 * chan2 set; the chan3 art carries the same colors) — deliberately the channel's colors, not the
 * school's official palette, per the no-school-branding rule. Used as the
 * cover/backdrop tint on channel profile pages.
 */
const CHANNEL_COLORS: Record<string, string> = {
  "ch-niltv": "#C2A030",
  "ch-nilstar": "#C2A030",
  "ch-trueblue": "#0F2663",
  "ch-truebluetv": "#0F2663",
  "ch-dorecitytv": "#9E7533",
  "ch-chapelhilltv": "#89B7E4",
  "ch-starkvilletv": "#701020",
  "ch-collegestationtv": "#4E100E",
  "ch-goldendometv": "#135D29",
  "ch-redpacktv": "#A90E0D",
  "ch-brazostv": "#023E27",
  "ch-saltcitytv": "#ED3801",
  "ch-goldsalemtv": "#9D7B38",
};

export function channelColor(channelId: string): string | undefined {
  return CHANNEL_COLORS[channelId];
}

/**
 * The ingest bridge mints a channel `ch-{account}` AND a creator profile
 * `p-{account}` from the same dashboard account, so a campus channel's
 * pseudo-profile maps back to its channel by slug swap. Returns undefined for
 * ids that aren't profile-shaped.
 */
export function channelIdForProfile(profileId: string): string | undefined {
  return profileId.startsWith("p-") ? `ch-${profileId.slice(2)}` : undefined;
}

function Mark({
  source,
  height,
  aspect,
  style,
}: {
  source: number;
  height: number;
  aspect: number;
  style?: StyleProp<ImageStyle>;
}) {
  return (
    <Image
      source={source}
      style={[{ height, width: height * aspect }, style]}
      resizeMode="contain"
      accessibilityIgnoresInvertColors
    />
  );
}

/**
 * The gold NILTV wordmark (the site's nav logo, 697x220, cropped tight).
 * Still boxed at 2.4:1 so it width-fits and the header keeps its set size;
 * the old padded asset had the same ink inside a looser canvas.
 */
export function NiltvLogo({ height = 28, style }: { height?: number; style?: StyleProp<ImageStyle> }) {
  return <Mark source={NILTV_LOGO} height={height} aspect={2.4} style={style} />;
}

/** NIL Star wide mark, 742x252 (the site's nilstar-logo-wide.webp, no margin). */
export const NILSTAR_ASPECT = 742 / 252;

/** NIL STAR competition lockup (~2.94:1). */
export function NilstarLogo({ height = 40, style }: { height?: number; style?: StyleProp<ImageStyle> }) {
  return <Mark source={NILSTAR_LOGO} height={height} aspect={NILSTAR_ASPECT} style={style} />;
}

/**
 * One matcher for event-title → competition lockup, shared by the event
 * screen headline and the hub row thumbs. `hasCompetitionMark` lets callers
 * branch to fallback art (a JSX element is truthy even when it renders null).
 */
export function hasCompetitionMark(title: string): boolean {
  return /nil star/i.test(title);
}

/**
 * Wide wordmarks read far heavier than stacked ones at equal heights, so
 * CompetitionMark renders wide marks at a fraction of the requested height to
 * balance visual weight. Callers pass ONE height and get matched marks.
 */
const WIDE_MARK_SCALE = 0.65;

export function CompetitionMark({
  title,
  height = 40,
  width,
  style,
}: {
  title: string;
  height?: number;
  /**
   * Size by width instead — for hero placements where the mark spans the
   * column. Width is authoritative when given: each mark derives its height
   * from its own aspect, so WIDE_MARK_SCALE does not apply.
   */
  width?: number;
  style?: StyleProp<ImageStyle>;
}) {
  if (/nil star/i.test(title)) {
    const h =
      width !== undefined
        ? Math.round(width / NILSTAR_ASPECT)
        : Math.round(height * WIDE_MARK_SCALE);
    return <NilstarLogo height={h} style={style} />;
  }
  return null;
}
