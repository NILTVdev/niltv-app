import { FavoriteSport } from "@niltv/types";
import type { AthleteChip, MeFavorites } from "@niltv/types";

export const favoriteSports = FavoriteSport.options;

export function toggleFavorite<T extends string>(selected: readonly T[], value: T): T[] {
  return selected.includes(value) ? selected.filter((item) => item !== value) : [...selected, value];
}

export function normalizeFavorites(favorites: MeFavorites): MeFavorites {
  const schools = new Map<string, string>();
  for (const school of favorites.schools) {
    const trimmed = school.trim();
    const key = trimmed.toLowerCase();
    if (trimmed && !schools.has(key)) schools.set(key, trimmed);
  }
  return {
    schools: [...schools.values()],
    sports: [...new Set(favorites.sports)],
    channels: [...new Set(favorites.channels)],
  };
}

export function createFavoritesDraft(
  saved: MeFavorites,
  activeChannelIds: readonly string[],
): MeFavorites {
  const active = new Set(activeChannelIds);
  return normalizeFavorites({
    ...saved,
    channels: saved.channels.filter((channelId) => active.has(channelId)),
  });
}

export function schoolOptions(
  profiles: readonly Pick<AthleteChip, "school">[] | undefined,
  savedSchools: readonly string[] = [],
): string[] {
  const schools = new Map<string, string>();
  for (const value of [...(profiles ?? []).map((profile) => profile.school), ...savedSchools]) {
    const school = value.trim();
    const key = school.toLowerCase();
    if (school && !schools.has(key)) schools.set(key, school);
  }
  return [...schools.values()].sort((a, b) => a.localeCompare(b));
}

export function favoriteSportLabel(sport: (typeof favoriteSports)[number]): string {
  const labels: Partial<Record<(typeof favoriteSports)[number], string>> = {
    "cheer-dance": "Cheer & Dance",
    "cross-country": "Cross Country",
    "field-hockey": "Field Hockey",
    "ice-hockey": "Ice Hockey",
    "swim-dive": "Swim & Dive",
    "track-field": "Track & Field",
    "ultimate-frisbee": "Ultimate Frisbee",
  };
  return labels[sport] ?? sport.replace(/\b\w/g, (letter) => letter.toUpperCase()).replaceAll("-", " ");
}

function sameValues(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value) => right.includes(value));
}

export function favoritesEqual(left: MeFavorites, right: MeFavorites): boolean {
  const a = normalizeFavorites(left);
  const b = normalizeFavorites(right);
  return (
    sameValues(a.schools.map((school) => school.toLowerCase()), b.schools.map((school) => school.toLowerCase())) &&
    sameValues(a.sports, b.sports) &&
    sameValues(a.channels, b.channels)
  );
}

export function favoritesErrorMessage(error: unknown, context: "load" | "options" | "save"): string {
  const details =
    typeof error === "object" && error !== null ? (error as { code?: unknown; status?: unknown }) : undefined;
  if (details?.status === 401 || details?.code === "NO_SESSION") {
    return "Your session has expired. Sign in again to manage favorites.";
  }
  if (details?.status === 400 || details?.code === "INVALID_REQUEST") {
    return "Some selections are no longer available. Review your choices and try again.";
  }
  if (context === "save") return "Could not save your favorites. Check your connection and try again.";
  if (context === "options") return "Could not load favorite options. Try again.";
  return "Could not load your favorites. Check your connection and try again.";
}