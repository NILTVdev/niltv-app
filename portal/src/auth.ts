/**
 * Cognito SRP auth (amazon-cognito-identity-js), same setup as the admin
 * tool. In a browser tab the library keeps the session in `sessionStorage`,
 * so a signed-in tab survives a reload but not a browser restart. Opened as
 * the installed app (from the Home Screen), it keeps the session in
 * `localStorage` instead, so closing the app does not sign people out.
 * Signing out clears the session from both. `getIdToken()` refreshes the
 * session through the refresh token five minutes before it expires, one
 * refresh at a time, and gives up after 12 seconds. Only Cognito refusing the
 * refresh token signs anyone out; a network or service failure keeps the
 * session (see lib/session.ts). A refresh writes its tokens only while the
 * session it started on is still the stored one.
 *
 * Portal accounts are ordinary niltv.com accounts; the portal API decides
 * who gets in (403 NOT_MEMBER), not Cognito. Accounts are created here too,
 * with the same fields as the site's form, so an invited athlete never has
 * to leave the portal. Cognito matches emails exactly, so everything tries the
 * lowercase form first, as the app does, then the address as typed: niltv.com
 * keeps an email as typed, so an older account can have capitals.
 */
import {
  AuthenticationDetails,
  CognitoIdToken,
  CognitoRefreshToken,
  CognitoUser,
  CognitoUserAttribute,
  CognitoUserPool,
  type CognitoUserSession,
} from "amazon-cognito-identity-js";
import { config } from "./config";
import { runningStandalone } from "./lib/push";
import {
  REFRESH_TIMEOUT_MS,
  type RefreshFence,
  cognitoCode,
  lateRefresh,
  parseClockDrift,
  refreshFailure,
  refreshTimeout,
  serverNow,
  settleRefresh,
  tokenStep,
} from "./lib/session";

let pool: CognitoUserPool | undefined;
let store: Storage | undefined;

/** localStorage for the installed app (when the browser allows it), sessionStorage for a tab. Fixed per page load. */
function sessionStore(): Storage {
  if (!store) {
    store = window.sessionStorage;
    if (runningStandalone()) {
      try {
        window.localStorage.getItem("niltv-portal:probe");
        store = window.localStorage;
      } catch {
        /* storage blocked: stay with the tab session */
      }
    }
  }
  return store;
}

function getPool(): CognitoUserPool {
  if (!pool) {
    const { userPoolId, clientId } = config.cognito;
    if (!userPoolId || !clientId) throw new Error("Cognito is not configured.");
    pool = new CognitoUserPool({ UserPoolId: userPoolId, ClientId: clientId, Storage: sessionStore() });
  }
  return pool;
}

const userFor = (email: string): CognitoUser =>
  new CognitoUser({ Username: email, Pool: getPool(), Storage: sessionStore() });

const clean = (email: string): string => email.trim().toLowerCase();

const emailForms = (email: string): string[] => [...new Set([clean(email), email.trim()])];

/** For steps Cognito answers honestly: the first form that works wins. */
async function firstForm(email: string, step: (form: string) => Promise<void>): Promise<void> {
  let last: unknown;
  for (const form of emailForms(email)) {
    try {
      return await step(form);
    } catch (err) {
      last = err;
    }
  }
  throw friendly(last);
}

/** For steps Cognito fakes when the address is unknown, so success says nothing: try every form. */
async function everyForm(email: string, step: (form: string) => Promise<void>): Promise<void> {
  const results = await Promise.allSettled(emailForms(email).map(step));
  if (results.some((r) => r.status === "fulfilled")) return;
  throw friendly((results[0] as PromiseRejectedResult).reason);
}

export class NotSignedInError extends Error {
  constructor() {
    super("Not signed in.");
    this.name = "NotSignedInError";
  }
}

/** Sign-in could not be reached to renew the session. The session is kept; try again later. */
export class SessionUnavailableError extends Error {
  constructor() {
    super("Could not reach sign-in. Check your connection and try again.");
    this.name = "SessionUnavailableError";
  }
}

/**
 * A refresh outlived the session it started on: a sign-out, or a sign-in
 * since. Storage now belongs to someone else, so this is not a session end.
 */
export class StaleRefreshError extends Error {
  constructor() {
    super("The session changed while it was being renewed. Try again.");
    this.name = "StaleRefreshError";
  }
}

/** The password was right, but the email code was never entered. The screen offers that step. */
export class NotConfirmedError extends Error {
  constructor() {
    super("This account is not confirmed yet.");
    this.name = "NotConfirmedError";
  }
}

const codeOf = (err: unknown): string | undefined =>
  (err as { code?: string; name?: string } | undefined)?.code ?? (err as { name?: string } | undefined)?.name;

/** Cognito error codes in plain words. */
function friendly(err: unknown): Error {
  const code = codeOf(err);
  const raw =
    err instanceof Error ? err.message : String((err as { message?: string } | undefined)?.message ?? err ?? "");
  switch (code) {
    case "NotAuthorizedException":
      return new Error("That email and password do not match.");
    case "UserNotFoundException":
      return new Error("That email and password do not match.");
    case "UserNotConfirmedException":
      return new NotConfirmedError();
    case "UsernameExistsException":
      return new Error("That email already has an account. Sign in instead.");
    case "UserLambdaValidationException":
      return new Error(raw.includes("AGE_MINIMUM") ? "You are too young for a NIL TV account." : "Check your birthdate and try again.");
    case "CodeMismatchException":
      return new Error("That code is not right. Check the email and try again.");
    case "ExpiredCodeException":
      return new Error("That code has expired. Ask for a new one.");
    case "InvalidPasswordException":
      return new Error("That password is too weak. Use at least 8 characters with a number, an uppercase and a lowercase letter.");
    case "InvalidParameterException":
      return new Error(
        raw.includes("no registered/verified")
          ? "This account was never confirmed, so there is nothing to reset. Sign in with the password you chose to get a new code, or write to support@niltv.com."
          : "Check your details and try again.",
      );
    case "LimitExceededException":
    case "TooManyRequestsException":
      return new Error("Too many tries. Wait a few minutes and try again.");
    default:
      return new Error(raw || "Something went wrong. Try again.");
  }
}

function emailOf(session: CognitoUserSession, fallback: string): string {
  const email = session.getIdToken().payload["email"];
  return typeof email === "string" && email ? email : fallback;
}

function authenticate(email: string, password: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const user = userFor(email);
    user.authenticateUser(new AuthenticationDetails({ Username: email, Password: password }), {
      onSuccess: (session) => resolve(emailOf(session, email)),
      onFailure: reject,
      newPasswordRequired: () => {
        reject(new Error("This account needs a new password. Use Forgot password to set one."));
      },
    });
  });
}

/** SRP sign-in. Resolves to the signed-in email. */
export async function signIn(email: string, password: string): Promise<string> {
  const [lower, typed] = emailForms(email);
  try {
    return await authenticate(lower!, password);
  } catch (err) {
    if (!typed || !["NotAuthorizedException", "UserNotFoundException"].includes(codeOf(err) ?? "")) throw friendly(err);
  }
  return authenticate(typed, password).catch((err: unknown) => {
    throw friendly(err);
  });
}

/** Create a niltv.com account. Cognito emails a code that confirmSignUp takes. */
export function signUp(input: { email: string; password: string; name: string; birthdate: string }): Promise<void> {
  const email = clean(input.email);
  const attributes = [
    new CognitoUserAttribute({ Name: "email", Value: email }),
    new CognitoUserAttribute({ Name: "name", Value: input.name.trim() }),
    new CognitoUserAttribute({ Name: "birthdate", Value: input.birthdate }),
  ];
  return new Promise((resolve, reject) => {
    getPool().signUp(email, input.password, attributes, [], (err) => (err ? reject(friendly(err)) : resolve()));
  });
}

export function confirmSignUp(email: string, code: string): Promise<void> {
  return firstForm(
    email,
    (form) =>
      new Promise((resolve, reject) => {
        userFor(form).confirmRegistration(code.trim(), false, (err) => {
          // A repeat after a lost response: the first try already worked.
          if (!err || /Current status is CONFIRMED/.test(String((err as Error).message))) resolve();
          else reject(err);
        });
      }),
  );
}

export function resendCode(email: string): Promise<void> {
  return everyForm(
    email,
    (form) =>
      new Promise((resolve, reject) => {
        userFor(form).resendConfirmationCode((err) => (err ? reject(err) : resolve()));
      }),
  );
}

/** Email a reset code. */
export function forgotPassword(email: string): Promise<void> {
  return everyForm(
    email,
    (form) =>
      new Promise((resolve, reject) => {
        userFor(form).forgotPassword({
          onSuccess: () => resolve(),
          onFailure: reject,
          inputVerificationCode: () => resolve(),
        });
      }),
  );
}

/** Set a new password with the emailed code. */
export function confirmPassword(email: string, code: string, newPassword: string): Promise<void> {
  return firstForm(
    email,
    (form) =>
      new Promise((resolve, reject) => {
        userFor(form).confirmPassword(code, newPassword, {
          onSuccess: () => resolve(),
          onFailure: reject,
        });
      }),
  );
}

/** The tokens this tab has stored for the last signed-in user. Read straight from storage, so nothing refreshes. */
function storedTokens(): {
  user: CognitoUser;
  idToken: string | null;
  refreshToken: string | null;
  clockDrift: number;
} | null {
  const user = getPool().getCurrentUser();
  if (!user) return null;
  const prefix = `CognitoIdentityServiceProvider.${config.cognito.clientId ?? ""}.${user.getUsername()}`;
  const s = sessionStore();
  return {
    user,
    idToken: s.getItem(`${prefix}.idToken`),
    refreshToken: s.getItem(`${prefix}.refreshToken`),
    clockDrift: parseClockDrift(s.getItem(`${prefix}.clockDrift`)),
  };
}

function idPayload(idToken: string | null): Record<string, unknown> | null {
  if (!idToken) return null;
  try {
    return new CognitoIdToken({ IdToken: idToken }).decodePayload() as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Expiry of an ID token in ms, or null when it cannot be read. */
function expiresAt(idToken: string | null): number | null {
  const exp = idPayload(idToken)?.["exp"];
  return typeof exp === "number" ? exp * 1000 : null;
}

/**
 * One refresh at a time: every caller that needs a new token waits on the
 * same one. Forced and unforced callers wait on separate refreshes, so a
 * caller that just got a 401 never receives the refused token back.
 */
const refreshing: Record<"plain" | "forced", Promise<string> | null> = { plain: null, forced: null };

/** Bumped by signOut(), so a refresh still in flight cannot bring the session back. */
let signOutGeneration = 0;

const keyPrefix = (): string => `CognitoIdentityServiceProvider.${config.cognito.clientId ?? ""}`;

/** Who is stored now, read straight from storage. Blocked storage reads as nobody. */
function storedSession(user: string): { lastAuthUser: string | null; storedRefreshToken: string | null } {
  try {
    const s = sessionStore();
    return {
      lastAuthUser: s.getItem(`${keyPrefix()}.LastAuthUser`),
      storedRefreshToken: s.getItem(`${keyPrefix()}.${user}.refreshToken`),
    };
  } catch {
    return { lastAuthUser: null, storedRefreshToken: null };
  }
}

/**
 * In-memory storage for one refresh. The library caches the new tokens here,
 * and clears them here on a refusal, so it never writes over a newer session.
 * `keepTokens` copies them to the real store once the session checks out.
 */
function scratchStore(user: string): Storage {
  const data = new Map<string, string>();
  const real = sessionStore();
  const lastUserKey = `${keyPrefix()}.LastAuthUser`;
  const deviceKey = `${keyPrefix()}.${user}.deviceKey`;
  data.set(lastUserKey, user);
  const device = real.getItem(deviceKey);
  if (device) data.set(deviceKey, device);
  return {
    get length() {
      return data.size;
    },
    key: (i: number) => [...data.keys()][i] ?? null,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, String(v)),
    removeItem: (k: string) => void data.delete(k),
    clear: () => data.clear(),
  };
}

function keepTokens(user: string, scratch: Storage): void {
  const real = sessionStore();
  for (const name of ["idToken", "accessToken", "refreshToken", "clockDrift"]) {
    const value = scratch.getItem(`${keyPrefix()}.${user}.${name}`);
    if (value !== null) real.setItem(`${keyPrefix()}.${user}.${name}`, value);
  }
  real.setItem(`${keyPrefix()}.LastAuthUser`, user);
}

function refresh(
  user: CognitoUser,
  refreshToken: string,
  staleToken: string | null,
  force: boolean,
  clockDrift: number,
): Promise<string> {
  const slot = force ? "forced" : "plain";
  const existing = refreshing[slot];
  if (existing) return existing;
  const fence: RefreshFence = { generation: signOutGeneration, user: user.getUsername(), refreshToken };
  const settle = () => settleRefresh({ started: fence, generation: signOutGeneration, ...storedSession(fence.user) });
  const scratch = scratchStore(fence.user);
  const worker = new CognitoUser({ Username: fence.user, Pool: getPool(), Storage: scratch });
  let pending: Promise<string> | undefined;
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  pending = new Promise<string>((resolve, reject) => {
    // The first answer wins: the Cognito callback or the timeout. Either frees the slot.
    const finish = (act: () => void): void => {
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      if (pending && refreshing[slot] === pending) refreshing[slot] = null;
      act();
    };
    /** The session changed under this refresh: clear only what is still its own, then tell the caller. */
    const staleOut = (state: ReturnType<typeof settle>): boolean => {
      if (state === "current") return false;
      if (state === "staleClear") clearStoredTokens();
      reject(new StaleRefreshError());
      return true;
    };
    timer = setTimeout(() => {
      if (settled) return;
      finish(() => {
        if (staleOut(settle())) return;
        const outcome = refreshTimeout({ idExpiresAt: expiresAt(staleToken), now: serverNow(clockDrift), force });
        if (outcome === "useStale" && staleToken) resolve(staleToken);
        else reject(new SessionUnavailableError());
      });
    }, REFRESH_TIMEOUT_MS);
    worker.refreshSession(new CognitoRefreshToken({ RefreshToken: refreshToken }), (err: unknown, session: CognitoUserSession | null) => {
      const state = settle();
      const ok = !err && Boolean(session);
      if (settled) {
        // Too late for the caller. New tokens still help the next request if the session is unchanged.
        if (lateRefresh({ settle: state, ok }) === "store") keepTokens(fence.user, scratch);
        return;
      }
      finish(() => {
        if (staleOut(state)) return;
        if (ok && session) {
          keepTokens(fence.user, scratch);
          resolve(session.getIdToken().getJwtToken());
          return;
        }
        const now = serverNow(clockDrift);
        const outcome = refreshFailure({ code: cognitoCode(err), idExpiresAt: expiresAt(staleToken), now, force });
        if (outcome === "signedOut") {
          clearStoredTokens();
          reject(new NotSignedInError());
        } else if (outcome === "useStale" && staleToken) resolve(staleToken);
        else reject(new SessionUnavailableError());
      });
    });
  });
  // The callback can only free the slot once `pending` is set, so an answer before this line leaves it empty.
  if (!settled) refreshing[slot] = pending;
  return pending;
}

/**
 * Current ID-token JWT for `Authorization: Bearer`, refreshed five minutes
 * before expiry, or always with `force` (after the API answers 401).
 * Rejects with NotSignedInError only when the session is really over, and
 * with SessionUnavailableError when sign-in cannot be reached.
 */
export async function getIdToken(options: { force?: boolean } = {}): Promise<string> {
  const force = options.force ?? false;
  const stored = storedTokens();
  if (!stored) throw new NotSignedInError();
  const { user, idToken, refreshToken, clockDrift } = stored;
  const now = serverNow(clockDrift);
  const step = tokenStep({ idExpiresAt: expiresAt(idToken), hasRefreshToken: Boolean(refreshToken), now, force });
  if (step === "use" && idToken) return idToken;
  if (step === "refresh" && refreshToken) return refresh(user, refreshToken, idToken, force, clockDrift);
  throw new NotSignedInError();
}

/**
 * Restore the saved session on load. `email` is null when signed out;
 * `ended` says Cognito refused the saved session, so sign-in can say why.
 * When sign-in cannot be reached, the saved session is kept and the portal
 * opens; its requests retry.
 */
export async function restoreSession(): Promise<{ email: string | null; ended: boolean }> {
  let stored: ReturnType<typeof storedTokens>;
  try {
    stored = storedTokens();
  } catch {
    return { email: null, ended: false };
  }
  if (!stored || (!stored.idToken && !stored.refreshToken)) return { email: null, ended: false };
  let token: string | null = stored.idToken;
  try {
    token = await getIdToken();
  } catch (err) {
    if (err instanceof NotSignedInError) return { email: null, ended: true };
  }
  const email = idPayload(token)?.["email"];
  return { email: typeof email === "string" && email ? email : stored.user.getUsername(), ended: false };
}

/**
 * Sign out here, and drop this app client's tokens from both storages: a
 * session saved by the installed app must not outlive a sign-out in a tab.
 */
export function signOut(): void {
  signOutGeneration += 1;
  refreshing.plain = null;
  refreshing.forced = null;
  try {
    getPool().getCurrentUser()?.signOut();
  } catch {
    /* not configured: nothing to sign out of */
  }
  clearStoredTokens();
}

function clearStoredTokens(): void {
  const prefix = `${keyPrefix()}.`;
  for (const pick of [() => window.localStorage, () => window.sessionStorage]) {
    try {
      const s = pick();
      const keys = Array.from({ length: s.length }, (_, i) => s.key(i));
      for (const k of keys) if (k?.startsWith(prefix)) s.removeItem(k);
    } catch {
      /* storage blocked: nothing was saved there */
    }
  }
}
