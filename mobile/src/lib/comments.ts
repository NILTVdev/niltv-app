import { screenComment } from "@niltv/types/comment-filter";
import {
  COMMENT_ERROR_LOCKED,
  COMMENT_ERROR_RATE_LIMITED,
  COMMENT_ERROR_REJECTED,
  COMMENT_ERROR_TERMS_REQUIRED,
  COMMENT_MAX_LENGTH,
} from "@niltv/types";

/**
 * True when the draft is something the server would refuse outright (slurs,
 * sexual content, threats). Same filter code as the backend, so the composer
 * can stop it before it is sent. The server still checks every post: this is
 * feedback, not the control. Held content (links, a minor's mild swearing) is
 * NOT blocked here; the server holds it for review.
 */
export function isExplicitDraft(draft: string): boolean {
  return screenComment(draft, { minor: false }).verdict === "reject";
}

/** The composer's send state: 1..COMMENT_MAX_LENGTH characters, and nothing explicit. */
export function canSubmitComment(draft: string): boolean {
  const n = draft.trim().length;
  return n > 0 && n <= COMMENT_MAX_LENGTH && !isExplicitDraft(draft);
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
    if (error.code === COMMENT_ERROR_LOCKED) return "This comment is under review and can't be changed.";
    if (error.status === 401) return "Sign in to comment.";
    // Route missing: the backend for this build isn't deployed yet.
    if (error.status === 404 || error.status === 405) return "Comments aren't available right now.";
  }
  return "Your comment wasn't posted. Please try again.";
}

/** True when the server wants the community guidelines accepted before the first comment. */
export function isTermsRequired(error: unknown): boolean {
  const e = error as { status?: unknown; code?: unknown } | null;
  return !!e && e.status === 403 && e.code === COMMENT_ERROR_TERMS_REQUIRED;
}

export interface HelpLink {
  label: string;
  url: string;
}

// Plain addresses only: no query string, fragment or encoded characters can ride along into the mailto: link.
const EMAIL_RE = /^[A-Za-z0-9._+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;

/**
 * Links shown beside the community guidelines (App Store 1.2: the terms users
 * agree to, and published contact information). Built from build-time config:
 * an unset or malformed value is left out rather than shown broken, and only
 * https and mailto links are ever produced.
 */
export function guidelineLinks(opts: { guidelinesUrl?: string; supportEmail?: string }): HelpLink[] {
  const links: HelpLink[] = [];
  const url = opts.guidelinesUrl?.trim();
  if (url && /^https:\/\/[^\s]+$/i.test(url)) links.push({ label: "Read the full guidelines", url });
  const email = opts.supportEmail?.trim();
  if (email && EMAIL_RE.test(email)) links.push({ label: "Contact us", url: `mailto:${email}` });
  return links;
}
