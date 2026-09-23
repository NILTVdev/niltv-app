/** Canonical TanStack Query keys — own module so non-hook code (auth store) can import without cycles. */
export const queryKeys = {
  config: ["config"] as const,
  home: ["home"] as const,
  events: ["events"] as const,
  event: (id: string) => ["events", id] as const,
  channels: ["channels"] as const,
  contentList: (channelId: string) => ["content", "list", channelId] as const,
  creatorContentList: (athleteId: string) => ["content", "creator", athleteId] as const,
  content: (id: string) => ["content", "detail", id] as const,
  profile: (id: string) => ["profiles", "detail", id] as const,
  /** profiles directory — `filter` is the query-string filter ("ambassador") or "all" */
  profiles: (filter: string) => ["profiles", "list", filter] as const,
  me: ["me"] as const,
};
