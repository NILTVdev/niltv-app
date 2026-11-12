/**
 * When a failed read is worth another try, and how long to wait. Pure, so
 * main.tsx can hand it to TanStack Query and tests can check it directly.
 *
 * Temporary: no connection (status 0), a server error (5xx) and too many
 * requests (429). Every other 4xx (signed out, no access, not found) will not
 * fix itself. Writes are never retried: a repeat could send twice.
 */

/** The parts of a PortalApiError this needs. */
export interface RetryableError {
  status?: number;
  retryAfter?: number;
}

const statusOf = (error: unknown): number | undefined => {
  const s = (error as RetryableError | null | undefined)?.status;
  return typeof s === "number" ? s : undefined;
};

export const isTemporary = (error: unknown): boolean => {
  const status = statusOf(error);
  if (status === undefined) return true;
  return status === 0 || status === 429 || status >= 500;
};

/** Reads: up to three more tries for a temporary failure. */
export const shouldRetryRead = (failureCount: number, error: unknown): boolean => failureCount < 3 && isTemporary(error);

const MAX_WAIT_MS = 30_000;

/** Backoff: 1s, 2s, 4s… capped at 30s. A 429 waits at least as long as the server asked. */
export function retryDelay(failureCount: number, error: unknown): number {
  const backoff = Math.min(1000 * 2 ** Math.max(0, failureCount - 1), MAX_WAIT_MS);
  if (statusOf(error) !== 429) return backoff;
  const asked = (error as RetryableError).retryAfter;
  return Math.min(Math.max(backoff * 2, asked ?? 0), MAX_WAIT_MS);
}

/** A Retry-After header (seconds, or an HTTP date) in ms; undefined when absent or unreadable. */
export function retryAfterMs(header: string | null, now = Date.now()): number | undefined {
  if (!header) return undefined;
  const value = header.trim();
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}
