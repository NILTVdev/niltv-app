import { COMMENT_ERROR_RATE_LIMITED, COMMENT_ERROR_REJECTED, COMMENT_MAX_LENGTH } from "@niltv/types";

/** The composer's send state: trimmed length within 1..COMMENT_MAX_LENGTH. */
export function canSubmitComment(draft: string): boolean {
  const n = draft.trim().length;
  return n > 0 && n <= COMMENT_MAX_LENGTH;
}

/** "now" · "5m" · "3h" · "2d" · "4w" · then a short date. Future/invalid timestamps read "now". */
export function commentAge(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "now";
  const s = Math.max(0, Math.floor((now - then) / 1000));
  if (s < 60) return "now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  if (d < 52 * 7) return `${Math.floor(d / 7)}w`;
  return new Date(then).toISOString().slice(0, 10);
}

/**
 * User-facing text for a failed post. The server's own `message` is never
 * shown for a filter rejection: it must not tell people which rule they hit.
 */
export function postErrorMessage(error: unknown): string {
  // Structural, not `instanceof ApiRequestError`: that module pulls in the
  // native auth stack, which vitest cannot load.
  const e = error as { status?: unknown; code?: unknown } | null;
  if (e && typeof e.status === "number" && typeof e.code === "string") {
    const error = { status: e.status, code: e.code };
    if (error.code === COMMENT_ERROR_REJECTED) {
      return "That comment goes against our community guidelines, so it wasn't posted.";
    }
    if (error.code === COMMENT_ERROR_RATE_LIMITED || error.status === 429) {
      return "You're commenting too fast. Please wait a moment.";
    }
    if (error.status === 401) return "Sign in to comment.";
  }
  return "Your comment wasn't posted. Please try again.";
}
