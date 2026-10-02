import type { AthleteChip } from "@niltv/types";

/**
 * Route params for /athlete/[id] carrying enough of the chip to paint the
 * header instantly. Unpublished profiles open the athlete's video listing.
 */
export function athleteParams(a: AthleteChip) {
  return {
    id: a.id,
    name: a.name,
    school: a.school,
    sport: a.sport,
    avatarUrl: a.avatarUrl ?? "",
    videos: a.profilePublished === true ? "0" : "1",
    isAmbassador: a.isAmbassador ? "1" : "0",
    rank: a.ambassadorRank !== undefined ? String(a.ambassadorRank) : "",
  };
}
