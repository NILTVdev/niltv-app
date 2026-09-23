/**
 * The Home hero's featured slides. This list follows the website homepage hero, the
 * .hero-slide cards in webapp/concepts/cinema/index.html (the chrome the
 * built webapp/index.html comes from): same order, same kicker / title /
 * dek copy. One deliberate difference: the app DROPS the site's
 * NIL Star reel slide, so the app hero is the three horizontal episodes and
 * HeroCarousel collapses to its compact wide-band height. Re-adding a 9:16
 * reel (aspect "9:16", watch.kind "content") restores the tall hero.
 *
 * Media, per hz id (uploaded by a maintainer): hero-loop.mp4
 * is the 30 s muted 720p billboard cut, master-fs.mp4 the full faststart
 * episode the Watch CTA plays in app/theater.tsx, poster.jpg the still. All
 * three exist in both stage buckets under the same keys, so the caller
 * passes its stage CDN (config.apiBase).
 */
export interface FeaturedSlide {
  key: string;
  /** Eyebrow above the title (site .hero-kicker). */
  kicker: string;
  /** Rendered as the competition lockup when Brand.hasCompetitionMark matches. */
  title: string;
  /** One line under the title (site .hero-dek). */
  dek: string;
  aspect: "16:9" | "9:16";
  /** The billboard loop the carousel plays behind the copy. */
  loopUrl: string;
  posterUrl: string;
  /** False hides the carousel's sound chip: the hz loops carry no audio track. */
  hasAudio: boolean;
  /** What the gold Watch CTA (and a tap anywhere on the card) does. */
  watch:
    | { kind: "theater"; src: string; poster: string; title: string; kicker: string }
    | { kind: "content"; contentId: string; channelId: string };
}

/** One horizontal (hz) episode: loop, poster and full cut share a folder. */
function horizontal(
  cdn: string,
  id: string,
  copy: { kicker: string; title: string; dek: string; theaterTitle: string; theaterKicker: string },
): FeaturedSlide {
  const dir = `${cdn}/video/${id}`;
  return {
    key: id,
    kicker: copy.kicker,
    title: copy.title,
    dek: copy.dek,
    aspect: "16:9",
    loopUrl: `${dir}/hero-loop.mp4`,
    posterUrl: `${dir}/poster.jpg`,
    hasAudio: false,
    watch: {
      kind: "theater",
      src: `${dir}/master-fs.mp4`,
      poster: `${dir}/poster.jpg`,
      title: copy.theaterTitle,
      kicker: copy.theaterKicker,
    },
  };
}

/** The site's horizontal hero episodes, in site order, built off the given stage CDN. */
export function featuredSlides(cdn: string): FeaturedSlide[] {
  return [
    horizontal(cdn, "hz-sweat-it-out", {
      kicker: "First Look",
      title: "Sweat It Out",
      dek: "Duke Athletes take on the Bull City Pepper Co. hot sauce challenge.",
      theaterTitle: "Sweat It Out with Bull City Pepper Co.",
      theaterKicker: "Sweat It Out",
    }),
    horizontal(cdn, "hz-big-noon-kickoff", {
      kicker: "Gameday",
      title: "Big Noon Kickoff",
      dek: "UC vs BYU from the sidelines.",
      theaterTitle: "Big Noon Kickoff, UC vs BYU",
      theaterKicker: "Gameday",
    }),
    horizontal(cdn, "hz-uca-nationals", {
      kicker: "Cheer",
      title: "UCA Nationals 2026",
      dek: "Cincinnati's run at Nationals, vlogged.",
      theaterTitle: "UCA Nationals 2026, Cincinnati",
      theaterKicker: "Cheer",
    }),
  ];
}

/**
 * The site's NIL Star billboard (Season 1 champion kicker, lockup, dek, Watch
 * on the champion reel). Not on the Home hero (no 9:16 reel there); the
 * Competitions tab leads with it whenever no competition is open, exactly
 * as /competitions/ does.
 */
export function nilStarBillboard(cdn: string): FeaturedSlide {
  return {
    key: "ig-18106275875112509",
    kicker: "Season 1 Champion Crowned",
    // "NIL Star" so the carousel renders the lockup, exactly as event slides do.
    title: "NIL Star",
    // The site's hard break before "Season 2" (.dek-2line); without it a
    // 360dp phone wraps to three lines and loses the date.
    dek: "Bella Calvanese is our first ever NIL STAR, taking home $10,000.\nSeason 2 arrives in 2027.",
    aspect: "9:16",
    loopUrl: `${cdn}/video/ig-18106275875112509/master.mp4`,
    posterUrl: `${cdn}/video/ig-18106275875112509/poster.jpg`,
    hasAudio: true,
    watch: { kind: "content", contentId: "ig-18106275875112509", channelId: "ch-nilstar" },
  };
}

/**
 * The Season 1 audition compilation, a horizontal cut for the Competitions
 * tab's billboard. Same hz folder layout as the hero episodes, so it
 * goes up the same way under the id
 * hz-nilstar-auditions (master-fs.mp4 + poster.jpg; WideBillboard plays no
 * loop, so hero-loop.mp4 is optional for this slide). The tab only shows it
 * once poster.jpg answers on the stage CDN.
 */
export function nilStarAuditionsBillboard(cdn: string): FeaturedSlide {
  return horizontal(cdn, "hz-nilstar-auditions", {
    // Copy follows the cut's own title card. The dek is one phone
    // line: WideBillboard never wraps it, so keep it short.
    kicker: "Audition Compilation",
    title: "NIL Singing Star Finalists",
    dek: "Every finalist's audition in one cut.",
    theaterTitle: "NIL Singing Star Finalists: The Auditions",
    theaterKicker: "Audition Compilation",
  });
}
