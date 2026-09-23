/**
 * The site's network marquee (webapp/channels/index.html .chmq; motion,
 * not video): two slow rails of real posters over the
 * channels hero. The ids are the site's own picks in the site's order; the
 * web build crops these posters into assets/img/chmq, the app reads the same
 * CDN posters straight off the stage (`/video/{id}/poster.jpg`, present on
 * every stage). Kept pure (no react-native) so the rows and the URL rule are
 * unit-tested; NetworkMarquee renders them.
 */

/** Row A (chmq-mq--a): nine posters. */
export const MARQUEE_ROW_A: readonly string[] = [
  "ig-18275620366295532",
  "tbtv-DYmqvT-vf5k",
  "ig-18138746563511713",
  "ig-17928150768394197",
  "ig-18106682875737198",
  "tbtv-DYkyFXvSDjT",
  "ig-18087898862367539",
  "tbtv-DYIsojsRHTH",
  "ig-18026514830905320",
];

/** Row B (chmq-mq--b): twelve posters; two repeat from row A, as on the site. */
export const MARQUEE_ROW_B: readonly string[] = [
  "ig-17902243089530973",
  "tbtv-DYP2awaucJT",
  "ig-17909147277446918",
  "tbtv-DYnsMfYsQQ-",
  "tbtv-DYIsojsRHTH",
  "ig-18004077713755504",
  "ig-18108576370921903",
  "ig-17908049181280440",
  "ig-17928150768394197",
  "ig-17880741309441315",
  "ig-18121260613806693",
  "tbtv-DYfPCxLCZf1",
];

/** The stage's poster for a content id: `{cdn}/video/{id}/poster.jpg`. */
export function marqueePosterUrl(cdn: string, id: string): string {
  return `${cdn}/video/${id}/poster.jpg`;
}
