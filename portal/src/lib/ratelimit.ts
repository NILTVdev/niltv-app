/**
 * The portal API caps writes per member (429 RATE_LIMITED). The refusal comes
 * before the route runs, so the same request is safe to send again once the
 * wait is over. Short waits are retried for the member; long ones (Help per
 * hour, page requests per day) show the server's message instead.
 */

/** Waits longer than this are not retried automatically. */
export const AUTO_RETRY_MAX_SEC = 90;

/** How long to wait before sending again, or undefined when the error is not a short rate limit. */
export function rateLimitWaitMs(err: unknown): number | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const { status, retryAfterSec } = err as { status?: unknown; retryAfterSec?: unknown };
  if (status !== 429) return undefined;
  const sec = typeof retryAfterSec === "number" ? retryAfterSec : 30;
  if (sec > AUTO_RETRY_MAX_SEC) return undefined;
  // A little past the window edge, so the retry lands in the new window.
  return Math.max(1, sec) * 1000 + 500;
}
