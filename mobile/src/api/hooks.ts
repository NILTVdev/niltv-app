import {
  AckResponse,
  AthleteChip,
  ChannelsResponse,
  ConfigResponse,
  ContentDetailResponse,
  ContentListResponse,
  EventDetailResponse,
  EventsListResponse,
  FollowAckResponse,
  HomeResponse,
  LikeAckResponse,
  MeResponse,
  type NewsletterRequest,
  type NotificationFollow,
  ProfileResponse,
  VoteResponse,
} from "@niltv/types";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useAuthStore } from "@/auth/store";
import { track } from "@/telemetry";

import { request, type Schema } from "./client";
import { queryKeys } from "./keys";

export { queryKeys };

/**
 * `{ profiles: AthleteChip[] }` — the profiles-list envelope, composed locally
 * (the directory ships dark; the shared contract doesn't carry it yet).
 * Validation still runs through the imported AthleteChip zod schema, keeping
 * the app free of a direct zod import (see client.ts).
 */
const ProfileChips = AthleteChip.array();
const ProfilesListResponse: Schema<{ profiles: AthleteChip[] }> = {
  parse: (input) => ({
    profiles: ProfileChips.parse((input as { profiles?: unknown } | null | undefined)?.profiles),
  }),
};

export function useConfig() {
  return useQuery({
    queryKey: queryKeys.config,
    queryFn: () => request("/v1/config", ConfigResponse),
    staleTime: 60_000,
  });
}

export function useHome() {
  return useQuery({
    queryKey: queryKeys.home,
    queryFn: () => request("/v1/home", HomeResponse),
    staleTime: 60_000,
  });
}

export function useEvents() {
  return useQuery({
    queryKey: queryKeys.events,
    queryFn: () => request("/v1/events", EventsListResponse),
    staleTime: 60_000,
  });
}

export function useEvent(id: string) {
  return useQuery({
    queryKey: queryKeys.event(id),
    queryFn: () => request(`/v1/events/${id}`, EventDetailResponse),
    staleTime: 30_000,
    enabled: id.length > 0,
  });
}

/** The channel list — flagship NIL TV, the campus channels, legacy properties. Near-static. */
export function useChannels() {
  return useQuery({
    queryKey: queryKeys.channels,
    queryFn: () => request("/v1/channels", ChannelsResponse),
    staleTime: 300_000,
  });
}

/** Watch grid pages for a channel — cursor-paged infinite scroll. */
export function useContentList(channelId: string) {
  return useInfiniteQuery({
    queryKey: queryKeys.contentList(channelId),
    queryFn: ({ pageParam }) =>
      request(
        `/v1/content?channelId=${encodeURIComponent(channelId)}${
          pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ""
        }`,
        ContentListResponse,
      ),
    initialPageParam: "",
    getNextPageParam: (last) => last.cursor,
    staleTime: 60_000,
    enabled: channelId.length > 0,
  });
}

/**
 * One creator's clips, cursor-paged (GET /v1/content?athleteId=) — the
 * profile screen's infinite Content grid. The profile endpoint itself returns
 * only the first dozen clips; this pages through everything. retry stays off:
 * a backend without the athleteId param answers 400, and the screen then
 * falls back to the profile's own capped content list.
 */
export function useCreatorContentList(athleteId: string) {
  return useInfiniteQuery({
    queryKey: queryKeys.creatorContentList(athleteId),
    queryFn: ({ pageParam }) =>
      request(
        `/v1/content?athleteId=${encodeURIComponent(athleteId)}${
          pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ""
        }`,
        ContentListResponse,
      ),
    initialPageParam: "",
    getNextPageParam: (last) => last.cursor,
    staleTime: 60_000,
    retry: false,
    enabled: athleteId.length > 0,
  });
}

/**
 * One clip + creator + related. `enabled=false` defers the fetch — the video
 * feed only loads details for pages near the viewport.
 */
export function useContentDetail(id: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.content(id),
    queryFn: () => request(`/v1/content/${id}`, ContentDetailResponse),
    staleTime: 60_000,
    enabled: enabled && id.length > 0,
  });
}

/** Person profile + their content (GET /v1/profiles/{athleteId}). */
export function useProfile(athleteId: string) {
  return useQuery({
    queryKey: queryKeys.profile(athleteId),
    queryFn: () => request(`/v1/profiles/${athleteId}`, ProfileResponse),
    staleTime: 60_000,
    enabled: athleteId.length > 0,
  });
}

/** Ambassador directory (dark until flags.ambassadorDirectory — design §3.1). */
export function useAmbassadors() {
  return useQuery({
    queryKey: queryKeys.profiles("ambassador"),
    queryFn: () => request("/v1/profiles?filter=ambassador", ProfilesListResponse),
    staleTime: 300_000,
  });
}

/** Full profiles directory — the same endpoint unfiltered returns everyone. */
export function useProfilesAll() {
  return useQuery({
    queryKey: queryKeys.profiles("all"),
    queryFn: () => request("/v1/profiles", ProfilesListResponse),
    staleTime: 300_000,
  });
}

/**
 * Authenticated profile bundle. Enabled only while signed in; never persisted
 * to disk (meta.noPersist) and dropped from memory as soon as unobserved
 * (gcTime 0) — the auth store additionally removes it on sign-out.
 */
export function useMe() {
  const signedIn = useAuthStore((s) => s.status === "signedIn");
  return useQuery({
    queryKey: queryKeys.me,
    queryFn: () => request("/v1/me", MeResponse, { auth: true }),
    enabled: signedIn,
    staleTime: 30_000,
    gcTime: 0,
    meta: { noPersist: true },
  });
}

function useFollowMutation(followed: boolean) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (athleteId: string) =>
      request(`/v1/me/follows/${athleteId}`, FollowAckResponse, {
        method: followed ? "PUT" : "DELETE",
        auth: true,
      }),
    onMutate: async (athleteId: string) => {
      await qc.cancelQueries({ queryKey: queryKeys.me });
      const previous = qc.getQueryData<MeResponse>(queryKeys.me);
      if (previous) {
        const follows = followed
          ? previous.follows.includes(athleteId)
            ? previous.follows
            : [...previous.follows, athleteId]
          : previous.follows.filter((id) => id !== athleteId);
        qc.setQueryData<MeResponse>(queryKeys.me, { ...previous, follows });
      }
      return { previous };
    },
    onError: (_error, _athleteId, context) => {
      if (context?.previous) qc.setQueryData(queryKeys.me, context.previous);
    },
    onSuccess: (_data, athleteId) => track(followed ? "follow" : "unfollow", { athleteId }),
    onSettled: () => qc.invalidateQueries({ queryKey: queryKeys.me }),
  });
}

/** PUT /v1/me/follows/{athleteId} with optimistic update of me.follows. */
export function useFollow() {
  return useFollowMutation(true);
}

/** DELETE /v1/me/follows/{athleteId} with optimistic update of me.follows. */
export function useUnfollow() {
  return useFollowMutation(false);
}

/**
 * Like/unlike a clip with optimistic updates in two caches: membership in
 * me.likes (source of the heart's on/off state) and the display count on the
 * clip's detail response. Both roll back together on error. The ack carries
 * the server's count, which replaces the optimistic one on success;
 * an ack without a count keeps the optimistic one.
 */
function useLikeMutation(liked: boolean) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (contentId: string) =>
      request(`/v1/me/likes/${contentId}`, LikeAckResponse, {
        method: liked ? "POST" : "DELETE",
        auth: true,
      }),
    onMutate: async (contentId: string) => {
      await qc.cancelQueries({ queryKey: queryKeys.me });
      const previousMe = qc.getQueryData<MeResponse>(queryKeys.me);
      const previousDetail = qc.getQueryData<ContentDetailResponse>(queryKeys.content(contentId));
      // Cancel a detail refetch only when a copy is cached. Cancelling the
      // first fetch (a tap before the detail arrived) leaves the query idle
      // with no data and no playback url, and nothing restarts it.
      if (previousDetail) await qc.cancelQueries({ queryKey: queryKeys.content(contentId) });

      const wasLiked = previousMe?.likes.includes(contentId) ?? false;
      if (previousMe) {
        const likes = liked
          ? wasLiked
            ? previousMe.likes
            : [...previousMe.likes, contentId]
          : previousMe.likes.filter((id) => id !== contentId);
        qc.setQueryData<MeResponse>(queryKeys.me, { ...previousMe, likes });
      }
      // Only move the display count when the state actually flips (idempotent taps).
      if (previousDetail && wasLiked !== liked) {
        qc.setQueryData<ContentDetailResponse>(queryKeys.content(contentId), {
          ...previousDetail,
          likes: Math.max(0, previousDetail.likes + (liked ? 1 : -1)),
        });
      }
      return { previousMe, previousDetail };
    },
    onError: (_error, contentId, context) => {
      if (context?.previousMe) qc.setQueryData(queryKeys.me, context.previousMe);
      if (context?.previousDetail) {
        qc.setQueryData(queryKeys.content(contentId), context.previousDetail);
      }
    },
    onSuccess: (data, contentId) => {
      // Take the count from the ack, keeping the rest of the cached detail.
      // An ack without one (an older server, or a failed counter read-back)
      // leaves the optimistic count in place.
      const likes = data.likes;
      if (likes !== undefined) {
        qc.setQueryData<ContentDetailResponse>(queryKeys.content(contentId), (detail) =>
          detail ? { ...detail, likes } : detail,
        );
      }
      track(liked ? "like" : "unlike", { contentId });
    },
    onSettled: (_data, _error, contentId) => {
      void qc.invalidateQueries({ queryKey: queryKeys.me });
      // A cached detail is not refetched: the read is edge-cached for 60 s,
      // so a refetch would overwrite the ack's count with the stale copy,
      // heart red and count back to 0. With nothing cached (a tap before the
      // first fetch resolved) the fetch is restarted instead.
      if (qc.getQueryData(queryKeys.content(contentId)) === undefined) {
        void qc.invalidateQueries({ queryKey: queryKeys.content(contentId) });
      }
    },
  });
}

/** POST /v1/me/likes/{contentId} — optimistic heart-on + count bump. */
export function useLike() {
  return useLikeMutation(true);
}

/** DELETE /v1/me/likes/{contentId} — optimistic heart-off + count drop. */
export function useUnlike() {
  return useLikeMutation(false);
}

/**
 * PUT /v1/me/notification-follows — batch REPLACE of the ★-picker opt-ins
 * (the picker's "Done", the signup interest step, and upcoming-event "Notify
 * me" all send the full desired list). Optimistic on me.notificationFollows.
 */
export function useSetNotificationFollows() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (follows: NotificationFollow[]) =>
      request("/v1/me/notification-follows", AckResponse, {
        method: "PUT",
        body: { follows },
        auth: true,
      }),
    onMutate: async (follows) => {
      await qc.cancelQueries({ queryKey: queryKeys.me });
      const previous = qc.getQueryData<MeResponse>(queryKeys.me);
      if (previous) {
        qc.setQueryData<MeResponse>(queryKeys.me, { ...previous, notificationFollows: follows });
      }
      return { previous };
    },
    onError: (_error, _follows, context) => {
      if (context?.previous) qc.setQueryData(queryKeys.me, context.previous);
    },
    onSuccess: (_data, follows) => track("notif_follows_set", { count: follows.length }),
    onSettled: () => qc.invalidateQueries({ queryKey: queryKeys.me }),
  });
}

/** PUT /v1/me/push — the Profile global push toggle, optimistic on me.pushEnabled. */
export function useSetPushEnabled() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (enabled: boolean) =>
      request("/v1/me/push", AckResponse, { method: "PUT", body: { enabled }, auth: true }),
    onMutate: async (enabled) => {
      await qc.cancelQueries({ queryKey: queryKeys.me });
      const previous = qc.getQueryData<MeResponse>(queryKeys.me);
      if (previous) qc.setQueryData<MeResponse>(queryKeys.me, { ...previous, pushEnabled: enabled });
      return { previous };
    },
    onError: (_error, _enabled, context) => {
      if (context?.previous) qc.setQueryData(queryKeys.me, context.previous);
    },
    onSuccess: (_data, enabled) => track("push_toggle", { enabled }),
    onSettled: () => qc.invalidateQueries({ queryKey: queryKeys.me }),
  });
}

/** POST /v1/newsletter — public capture; `source` tags the entry point (spec §5.6). */
export function useNewsletterSignup() {
  return useMutation({
    mutationFn: (body: NewsletterRequest) =>
      request("/v1/newsletter", AckResponse, { method: "POST", body, auth: false }),
    onSuccess: (_data, body) => track("newsletter_signup", { source: body.source }),
  });
}

/**
 * DELETE /v1/me — account deletion (App Store 5.1.1(v), design §6.6). The
 * caller signs out on success; votes stay in tallies, anonymized server-side.
 */
export function useDeleteAccount() {
  return useMutation({
    mutationFn: () => request("/v1/me", AckResponse, { method: "DELETE", auth: true }),
    onSuccess: () => track("account_deleted"),
  });
}

/**
 * POST /v1/events/{eventId}/vote — the §6.3 integrity path. Deliberately NOT
 * optimistic: a vote is a one-shot commitment, so the UI waits for the 201
 * (or a typed error: AGE_GATE / WINDOW_CLOSED / ALREADY_VOTED via
 * ApiRequestError.code) before showing "Your pick" + the share sheet.
 */
export function useVote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ eventId, entryId }: { eventId: string; entryId: string }) =>
      request(`/v1/events/${eventId}/vote`, VoteResponse, {
        method: "POST",
        body: { entryId },
        auth: true,
      }),
    onSuccess: ({ eventId, entryId }) => {
      track("vote", { eventId, entryId });
      const me = qc.getQueryData<MeResponse>(queryKeys.me);
      if (me) {
        qc.setQueryData<MeResponse>(queryKeys.me, {
          ...me,
          votes: { ...me.votes, [eventId]: entryId },
        });
      }
    },
    onSettled: (_data, _error, { eventId }) => {
      void qc.invalidateQueries({ queryKey: queryKeys.me });
      void qc.invalidateQueries({ queryKey: queryKeys.event(eventId) });
    },
  });
}
