/**
 * Decisions behind keeping a member signed in, as pure functions so they can
 * be tested without Cognito or a browser. `auth.ts` and `api.ts` act on them.
 *
 * The rule: only Cognito saying the refresh token is no good
 * (NotAuthorizedException), or having no tokens at all, means signed out.
 * A dropped connection, a timeout or a Cognito outage never signs anyone out
 * and never clears the refresh token.
 */

/** Refresh this long before the ID token expires, so a request never goes out with a token about to lapse. */
export const REFRESH_MARGIN_MS = 5 * 60 * 1000;

export type TokenStep = "use" | "refresh" | "signedOut";

/**
 * What to do for a request, from what is stored.
 * `idExpiresAt` is the ID token's expiry in ms (null when there is none);
 * `force` asks for a new token even when the stored one looks good (after a 401).
 */
export function tokenStep(input: {
  idExpiresAt: number | null;
  hasRefreshToken: boolean;
  now: number;
  force?: boolean;
}): TokenStep {
  const { idExpiresAt, hasRefreshToken, now, force = false } = input;
  if (!force && idExpiresAt !== null && idExpiresAt - now > REFRESH_MARGIN_MS) return "use";
  if (hasRefreshToken) return "refresh";
  // No refresh token: a token that is still good can be used until it lapses.
  if (!force && idExpiresAt !== null && idExpiresAt > now) return "use";
  return "signedOut";
}

export type RefreshFailure = "signedOut" | "useStale" | "unavailable";

/**
 * A refresh failed. Only NotAuthorizedException ends the session. Anything
 * else is temporary: keep using the current token while it is still valid,
 * or report the sign-in service as unreachable. A forced refresh follows a
 * 401, so the stored token is known to be refused and is never reused.
 */
export function refreshFailure(input: {
  code: string | undefined;
  idExpiresAt: number | null;
  now: number;
  force?: boolean;
}): RefreshFailure {
  if (input.code === "NotAuthorizedException") return "signedOut";
  if (!input.force && input.idExpiresAt !== null && input.idExpiresAt > input.now) return "useStale";
  return "unavailable";
}

/** A 401 from the API: refresh and retry the request once; a second 401 ends the session. */
export const after401 = (alreadyRetried: boolean): "refreshAndRetry" | "signOut" =>
  alreadyRetried ? "signOut" : "refreshAndRetry";

/** The error code Cognito puts on a failure (`code`, or `name` as a fallback). */
export function cognitoCode(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const e = err as { code?: unknown; name?: unknown };
  if (typeof e.code === "string" && e.code) return e.code;
  if (typeof e.name === "string" && e.name) return e.name;
  return undefined;
}
