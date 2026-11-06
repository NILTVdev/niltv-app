/** Launch channel fallback shared by GET /v1/channels and favorites validation. */
export const FALLBACK_CHANNEL_IDS = ["ch-trueblue", "ch-niltv"] as const;

/** Resolve the configured public channel list with the same fallback as GET /v1/channels. */
export function channelIdsFromConfig(config: { channelIds?: unknown } | undefined): readonly string[] {
  const configured = config?.channelIds;
  return Array.isArray(configured) && configured.length > 0 && configured.every((id) => typeof id === "string")
    ? configured as string[]
    : FALLBACK_CHANNEL_IDS;
}