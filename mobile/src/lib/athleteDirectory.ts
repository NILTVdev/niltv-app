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
