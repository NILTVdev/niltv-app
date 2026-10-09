import type { ContentCard } from "@niltv/types";

/** The API supplies newest-first order. Hide stale results after a failed read. */
export function recentAthleteVideos(items: readonly ContentCard[] | undefined, athleteId: string, failed = false): ContentCard[] {
  if (failed || !items) return [];
  const seen = new Set<string>();
  return items.filter((clip) => {
    if (clip.creatorId !== athleteId || seen.has(clip.id)) return false;
    seen.add(clip.id);
    return true;
  }).slice(0, 3);
}

export function athleteVideoRoute(contentId: string, athleteId: string) {
  return {
    pathname: "/video/[contentId]" as const,
    params: { contentId, profileId: athleteId },
  };
}