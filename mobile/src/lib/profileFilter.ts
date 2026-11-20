import type { AthleteChip } from "@niltv/types";

type Filterable = Pick<AthleteChip, "name" | "school" | "sport">;

export interface ProfileFilters {
  /** Free-text name search; blank matches everyone. */
  query: string;
  /** Exact school to keep, or null for all. */
  school: string | null;
  /** Exact sport to keep, or null for all. */
  sport: string | null;
}

export const NO_FILTERS: ProfileFilters = { query: "", school: null, sport: null };

/** Lowercase and strip accents, so "jose" finds "José". */
const fold = (s: string): string =>
  s
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .trim();

/** Keeps the profiles matching the name search and the school and sport picks. */
export function filterProfiles<T extends Filterable>(profiles: T[], filters: ProfileFilters): T[] {
  const query = fold(filters.query);
  return profiles.filter(
    (p) =>
      (filters.school === null || p.school === filters.school) &&
      (filters.sport === null || p.sport === filters.sport) &&
      (query === "" || fold(p.name).includes(query)),
  );
}

/** The distinct, non-empty values of `key`, sorted for a chip row. */
export function filterOptions<T extends Filterable>(profiles: T[], key: "school" | "sport"): string[] {
  const values = new Set<string>();
  for (const p of profiles) {
    const v = p[key].trim();
    if (v) values.add(v);
  }
  return [...values].sort((a, b) => a.localeCompare(b));
}
