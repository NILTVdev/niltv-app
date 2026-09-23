/**
 * Does a media file exist on the stage CDN? One HEAD per url, cached six
 * hours, never retried. Lets a billboard self-activate when its media lands
 * in the bucket, no release needed: the screen keeps asking until the
 * upload is there, then renders. `undefined` while the probe is pending or
 * failed, so a caller renders nothing until it has a real answer. The cached
 * answer persists with the query cache, so a fresh upload shows within the
 * staleTime at most, at once on a cold cache.
 */
import { useQuery } from "@tanstack/react-query";

export function useAssetExists(url: string | undefined): boolean | undefined {
  const query = useQuery({
    queryKey: ["asset-exists", url],
    queryFn: async () => {
      const res = await fetch(url ?? "", { method: "HEAD" });
      return res.ok;
    },
    enabled: url !== undefined,
    staleTime: 6 * 60 * 60 * 1000,
    retry: 0,
  });
  return query.data;
}
