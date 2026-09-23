/**
 * A fixed, ordered set of clips by id (the Competitions shelves
 * mirror the site's hand-picked lists, and content has no eventId to query
 * by). One /v1/content/{id} per id through useQueries, on the same key as
 * useContentDetail so the video screen and this hook share one cache entry.
 * 44 small GETs for the two shelves is fine: the edge caches them.
 */
import { ContentDetailResponse, type ContentCard } from "@niltv/types";
import { useQueries } from "@tanstack/react-query";

import { request } from "@/api/client";
import { queryKeys } from "@/api/keys";

export interface ContentByIds {
  /** Loaded cards in the input order. Pending or failed ids are skipped. */
  cards: ContentCard[];
  /** Any id still loading. A failed id (a tombstoned clip 404s) just drops out. */
  pending: boolean;
}

/** The detail response as the card shape rails and grids take. */
export function detailToCard(d: ContentDetailResponse): ContentCard {
  return {
    id: d.id,
    title: d.title,
    channelId: d.channelId,
    channelName: d.channelName,
    creatorId: d.creator.id,
    creatorName: d.creator.name,
    creatorIsAmbassador: d.creator.isAmbassador,
    thumbUrl: d.thumbUrl,
    duration: d.duration,
  };
}

export function useContentByIds(ids: readonly string[]): ContentByIds {
  return useQueries({
    queries: ids.map((id) => ({
      queryKey: queryKeys.content(id),
      queryFn: () => request(`/v1/content/${id}`, ContentDetailResponse),
      // Hand-picked, immutable ids: never refire 44 GETs on every app
      // foreground, and never retry a 404 (tombstones) a second time.
      staleTime: 6 * 60 * 60 * 1000,
      retry: 0,
    })),
    combine: (results) => ({
      cards: results.flatMap((r) => (r.data ? [detailToCard(r.data)] : [])),
      pending: results.some((r) => r.isPending),
    }),
  });
}
