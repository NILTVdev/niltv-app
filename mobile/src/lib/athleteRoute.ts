import type { AthleteChip } from "@niltv/types";

/**
 * Route params for /athlete/[id] carrying enough of the chip to paint the
 * header instantly while GET /v1/profiles/{id} loads (the screen's fallback).
 */
export function athleteParams(a: AthleteChip) {
  return {
    id: a.id,
    name: a.name,
    school: a.school,
    sport: a.sport,
    isAmbassador: a.isAmbassador ? "1" : "0",
    rank: a.ambassadorRank !== undefined ? String(a.ambassadorRank) : "",
  };
}
