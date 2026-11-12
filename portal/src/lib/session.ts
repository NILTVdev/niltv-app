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

/**
 * The clock drift Cognito stored at sign-in, in seconds (device clock minus
 * the server's). Missing or junk reads as no drift.
 */
export function parseClockDrift(raw: string | null): number {
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(n) ? n : 0;
}

/** The device clock corrected by the stored drift, so token expiry is judged on the server's time. */
export const serverNow = (clockDriftSeconds: number, deviceNow: number = Date.now()): number =>
  deviceNow - clockDriftSeconds * 1000;

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

/** A refresh that has not answered in this long gives up, so no request waits on a hung Cognito call. */
export const REFRESH_TIMEOUT_MS = 12_000;

/** What a refresh started with: the sign-out generation, the user and the refresh token. */
export type RefreshFence = { generation: number; user: string; refreshToken: string };

export type RefreshSettle = "current" | "staleClear" | "staleKeep";

/**
 * A refresh answered (or timed out). Is it still the session it started on?
 * `current`: same generation, user and refresh token, so act on it.
 * `staleClear`: signed out since, but the old session is somehow stored again, so clear it.
 * `staleKeep`: someone else is stored now (a new sign-in), so leave storage alone.
 * The caller of a stale refresh gets an error that does not end the session.
 */
export function settleRefresh(input: {
  started: RefreshFence;
  generation: number;
  lastAuthUser: string | null;
  storedRefreshToken: string | null;
}): RefreshSettle {
  const { started } = input;
  const sameSession = input.lastAuthUser === started.user && input.storedRefreshToken === started.refreshToken;
  if (input.generation === started.generation) return sameSession ? "current" : "staleKeep";
  return sameSession ? "staleClear" : "staleKeep";
}

/**
 * A refresh answered after its timeout. Its caller already has an answer.
 * New tokens are still saved when the session is the one it started on.
 * Anything else, a failure included, is ignored.
 */
export const lateRefresh = (input: { settle: RefreshSettle; ok: boolean }): "store" | "ignore" =>
  input.settle === "current" && input.ok ? "store" : "ignore";

/** A refresh timed out. It is a network failure: never a sign-out. */
export const refreshTimeout = (input: { idExpiresAt: number | null; now: number; force?: boolean }): RefreshFailure =>
  refreshFailure({ code: undefined, ...input });
