import type { AthleteChip } from "@niltv/types";

const normalize = (value: string) => value.trim().normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

export function filterAthletes(athletes: readonly AthleteChip[], name: string, school: string, sport: string) {
  return athletes.filter((athlete) =>
    normalize(athlete.name).includes(normalize(name)) &&
    (!school || normalize(athlete.school) === normalize(school)) &&
    (!sport || normalize(athlete.sport) === normalize(sport)),
  ).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

export function athleteFilterOptions(athletes: readonly AthleteChip[], field: "school" | "sport") {
  const values = new Map<string, string>();
  for (const athlete of athletes) {
    const value = athlete[field].trim();
    if (value && !values.has(normalize(value))) values.set(normalize(value), value);
  }
  return [...values.values()].sort((a, b) => a.localeCompare(b));
}

/** One preview per athlete, newest first; names keep timestamp ties stable. */
export function discoverAthletes(athletes: readonly AthleteChip[]) {
  return athletes.filter((athlete) => athlete.latestVideo).sort((a, b) =>
    Date.parse(b.latestVideo!.publishedAt) - Date.parse(a.latestVideo!.publishedAt) ||
    a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
  );
}

/** Existing staff-assigned ambassador rank can supply a spotlight, when playable. */
export function spotlightAthlete(athletes: readonly AthleteChip[]) {
  return athletes.filter((athlete) => athlete.latestVideo && athlete.isAmbassador && athlete.ambassadorRank)
    .sort((a, b) => a.ambassadorRank! - b.ambassadorRank! || a.id.localeCompare(b.id))[0];
}
