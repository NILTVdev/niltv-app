/**
 * Query keys and the shared queries. Server state lives in TanStack Query;
 * interval polling pauses on its own while the tab is hidden
 * (refetchIntervalInBackground is off by default).
 */
import type { ConversationSummary, Desk, MemberListResponse, PortalMember } from "@niltv/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";
import { go } from "./lib/router";

export const qk = {
  me: ["me"] as const,
  inbox: ["inbox"] as const,
  conv: (id: string) => ["conv", id] as const,
  messages: (id: string) => ["messages", id] as const,
  people: (id: string, q: string) => ["people", id, q] as const,
  pushDevices: ["push-devices"] as const,
  members: ["members"] as const,
  events: ["events"] as const,
  availability: ["availability"] as const,
  heatmap: (type: string, value: string | undefined) => ["heatmap", type, value ?? ""] as const,
  postings: ["postings"] as const,
  requests: ["requests"] as const,
  myPosts: ["my-posts"] as const,
  settings: ["settings"] as const,
};

export const INBOX_POLL_MS = 20_000;
export const ME_POLL_MS = 60_000;

export function useInbox(poll = false) {
  return useQuery({
    queryKey: qk.inbox,
    queryFn: api.inbox,
    select: (r) => r.conversations,
    refetchInterval: poll ? INBOX_POLL_MS : false,
  });
}

export function useMembers(enabled = true) {
  return useQuery({ queryKey: qk.members, queryFn: api.members, select: (r) => r.members, enabled });
}

export function useEvents(enabled = true) {
  return useQuery({ queryKey: qk.events, queryFn: api.events, select: (r) => r.events, enabled });
}

export function usePostings(enabled = true) {
  return useQuery({ queryKey: qk.postings, queryFn: api.postings, select: (r) => r.postings, enabled });
}

export function useRequests(enabled = true) {
  return useQuery({ queryKey: qk.requests, queryFn: api.requests, select: (r) => r.requests, enabled });
}

/** Put a thread into the cached inbox (or refresh it) without waiting for the next poll. */
export function upsertInbox(
  qc: ReturnType<typeof useQueryClient>,
  summary: ConversationSummary,
): void {
  qc.setQueryData(qk.inbox, (old: { conversations: ConversationSummary[] } | undefined) => {
    if (!old) return old;
    const rest = old.conversations.filter((c) => c.id !== summary.id);
    return { conversations: [...rest, summary] };
  });
}

/** Swap one member in the cached roster. */
export function patchMember(qc: ReturnType<typeof useQueryClient>, next: PortalMember): void {
  qc.setQueryData<MemberListResponse>(qk.members, (old) =>
    old ? { members: old.members.map((m) => (m.sub === next.sub ? next : m)) } : old,
  );
}

/**
 * Open (or find) a desk thread and go to it. Athletes and guests open their
 * own; staff pass the person's sub.
 */
export function useOpenDesk() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { desk: Desk; personSub?: string }) => api.openDesk(input),
    onSuccess: (summary) => {
      upsertInbox(qc, summary);
      void qc.invalidateQueries({ queryKey: qk.inbox });
      go("messages", summary.id);
    },
  });
}
