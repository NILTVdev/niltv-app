/**
 * Thin promise wrapper around amazon-cognito-identity-js (SRP sign-in) with
 * token persistence in expo-secure-store. No Amplify.
 *
 * Session model:
 * - signIn/confirm persist id/access/refresh tokens + email under niltv.* keys.
 * - restoreSession() runs on boot: returns the identity if a usable id token
 *   exists (refreshing via the refresh token when needed).
 * - getIdToken() is what the API client calls per request — it refreshes
 *   whenever the id token is within 5 minutes of expiry (single-flight).
 */
import {
  AuthenticationDetails,
  CognitoIdToken,
  CognitoRefreshToken,
  CognitoUser,
  CognitoUserAttribute,
  CognitoUserPool,
  type CognitoUserSession,
  type ISignUpResult,
} from "amazon-cognito-identity-js";
import * as SecureStore from "expo-secure-store";

import { config } from "@/config";

const KEYS = {
  idToken: "niltv.idToken",
  accessToken: "niltv.accessToken",
  refreshToken: "niltv.refreshToken",
  email: "niltv.email",
} as const;

const REFRESH_MARGIN_MS = 5 * 60 * 1000;

const pool = new CognitoUserPool({
  UserPoolId: config.userPoolId,
  ClientId: config.userPoolClientId,
});

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function userFor(email: string): CognitoUser {
  return new CognitoUser({ Username: normalizeEmail(email), Pool: pool });
}

/** Cognito rejects with Error-ish objects carrying `code` (and/or `name`). */
export function cognitoErrorCode(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const e = error as { code?: unknown; name?: unknown };
    if (typeof e.code === "string" && e.code.length > 0) return e.code;
    if (typeof e.name === "string" && e.name.length > 0) return e.name;
  }
  return "";
}

/* ── token persistence ─────────────────────────────────────────────────────── */

async function persistSession(email: string, session: CognitoUserSession): Promise<void> {
  await Promise.all([
    SecureStore.setItemAsync(KEYS.idToken, session.getIdToken().getJwtToken()),
    SecureStore.setItemAsync(KEYS.accessToken, session.getAccessToken().getJwtToken()),
    SecureStore.setItemAsync(KEYS.refreshToken, session.getRefreshToken().getToken()),
    SecureStore.setItemAsync(KEYS.email, normalizeEmail(email)),
  ]);
}

async function clearSession(): Promise<void> {
  await Promise.all(Object.values(KEYS).map((key) => SecureStore.deleteItemAsync(key)));
}

/** Registered by the auth store — fired when the refresh token is dead. */
let onSessionLost: (() => void) | null = null;
export function setOnSessionLost(handler: () => void): void {
  onSessionLost = handler;
}

function tokenExpiryMs(idToken: string): number {
  try {
    return new CognitoIdToken({ IdToken: idToken }).getExpiration() * 1000;
  } catch {
    return 0;
  }
}

function decodeIdentity(idToken: string, fallbackEmail: string): { email: string; name: string } {
  try {
    const payload = new CognitoIdToken({ IdToken: idToken }).decodePayload() as Record<
      string,
      unknown
    >;
    return {
      email: typeof payload.email === "string" ? payload.email : fallbackEmail,
      name: typeof payload.name === "string" ? payload.name : "",
    };
  } catch {
    return { email: fallbackEmail, name: "" };
  }
}

/* ── refresh ───────────────────────────────────────────────────────────────── */

let refreshInFlight: Promise<string | null> | null = null;

/**
 * Exchange the refresh token for fresh tokens. On a definitive rejection
 * (revoked/expired refresh token) the session is cleared and onSessionLost
 * fires; on transient failures the current (possibly stale) id token is
 * returned so the API call itself can decide.
 */
function refreshIdToken(email: string, refreshToken: string, staleIdToken: string | null) {
  refreshInFlight ??= new Promise<{ session: CognitoUserSession | null; error: unknown }>(
    (resolve) => {
      userFor(email).refreshSession(
        new CognitoRefreshToken({ RefreshToken: refreshToken }),
        (error: unknown, session: CognitoUserSession | null) =>
          resolve({ session: error ? null : session, error }),
      );
    },
  )
    .then(async ({ session, error }) => {
      if (session) {
        await persistSession(email, session);
        return session.getIdToken().getJwtToken();
      }
      if (cognitoErrorCode(error) === "NotAuthorizedException") {
        // Refresh token revoked or expired — the session is gone for good.
        await clearSession();
        onSessionLost?.();
        return null;
      }
      // Transient (network etc.) — keep tokens, let the caller try the API.
      return staleIdToken;
    })
    .finally(() => {
      refreshInFlight = null;
    });
  return refreshInFlight;
}

/**
 * Current id token for `Authorization: Bearer` — refreshes when within
 * 5 minutes of expiry. Returns null when there is no restorable session.
 */
export async function getIdToken(): Promise<string | null> {
  const [idToken, refreshToken, email] = await Promise.all([
    SecureStore.getItemAsync(KEYS.idToken),
    SecureStore.getItemAsync(KEYS.refreshToken),
    SecureStore.getItemAsync(KEYS.email),
  ]);

  if (idToken && tokenExpiryMs(idToken) - Date.now() > REFRESH_MARGIN_MS) return idToken;

  if (refreshToken && email) {
    const stillValid = idToken !== null && tokenExpiryMs(idToken) > Date.now();
    return refreshIdToken(email, refreshToken, stillValid ? idToken : null);
  }

  // No refresh token: an expired id token is useless — treat as signed out.
  if (idToken && tokenExpiryMs(idToken) <= Date.now()) {
    await clearSession();
    return null;
  }
  return idToken;
}

/* ── flows ─────────────────────────────────────────────────────────────────── */

export function signUp(
  email: string,
  password: string,
  profile: { name: string; birthdate: string /* YYYY-MM-DD — required pool attribute */ },
): Promise<ISignUpResult> {
  const username = normalizeEmail(email);
  const attributes = [
    new CognitoUserAttribute({ Name: "email", Value: username }),
    new CognitoUserAttribute({ Name: "name", Value: profile.name }),
    new CognitoUserAttribute({ Name: "birthdate", Value: profile.birthdate }),
  ];
  return new Promise((resolve, reject) => {
    pool.signUp(username, password, attributes, [], (error, result) => {
      if (error || !result) reject(error ?? new Error("Sign-up failed"));
      else resolve(result);
    });
  });
}

export function confirmSignUp(email: string, code: string): Promise<void> {
  return new Promise((resolve, reject) => {
    userFor(email).confirmRegistration(code.trim(), true, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

export function resendCode(email: string): Promise<void> {
  return new Promise((resolve, reject) => {
    userFor(email).resendConfirmationCode((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

/** Start password recovery: Cognito emails a 6-digit code to the account. */
export function requestPasswordReset(email: string): Promise<void> {
  return new Promise((resolve, reject) => {
    userFor(email).forgotPassword({
      onSuccess: () => resolve(),
      onFailure: reject,
    });
  });
}

/** Complete password recovery with the emailed code and the new password. */
export function confirmPasswordReset(
  email: string,
  code: string,
  newPassword: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    userFor(email).confirmPassword(code.trim(), newPassword, {
      onSuccess: () => resolve(),
      onFailure: reject,
    });
  });
}

/** SRP sign-in; persists tokens and returns the identity for the auth store. */
export async function signIn(
  email: string,
  password: string,
): Promise<{ email: string; name: string; session: CognitoUserSession }> {
  const username = normalizeEmail(email);
  const session = await new Promise<CognitoUserSession>((resolve, reject) => {
    userFor(username).authenticateUser(
      new AuthenticationDetails({ Username: username, Password: password }),
      {
        onSuccess: resolve,
        onFailure: reject,
        // MVP has no admin-created users; surface as a normal failure.
        newPasswordRequired: () =>
          reject(Object.assign(new Error("Password change required"), { code: "NewPasswordRequired" })),
      },
    );
  });
  await persistSession(username, session);
  const identity = decodeIdentity(session.getIdToken().getJwtToken(), username);
  return { ...identity, session };
}

/**
 * Persist a session obtained OUTSIDE the SRP flow (hosted-UI federation).
 * The stored "email" key doubles as the refresh username — for federated
 * users that's the pool username (e.g. signinwithapple_…), which is what
 * REFRESH_TOKEN_AUTH expects. Returns the display identity.
 */
export async function persistRawSession(
  idToken: string,
  accessToken: string,
  refreshToken: string,
): Promise<{ email: string; name: string }> {
  let username = "";
  let identity = { email: "", name: "" };
  try {
    const payload = new CognitoIdToken({ IdToken: idToken }).decodePayload() as Record<
      string,
      unknown
    >;
    username = typeof payload["cognito:username"] === "string" ? payload["cognito:username"] : "";
    identity = decodeIdentity(idToken, "");
  } catch {
    // fall through with empty identity
  }
  await Promise.all([
    SecureStore.setItemAsync(KEYS.idToken, idToken),
    SecureStore.setItemAsync(KEYS.accessToken, accessToken),
    SecureStore.setItemAsync(KEYS.refreshToken, refreshToken),
    SecureStore.setItemAsync(KEYS.email, username || identity.email),
  ]);
  return identity;
}

export async function signOut(): Promise<void> {
  const email = await SecureStore.getItemAsync(KEYS.email);
  if (email) {
    try {
      userFor(email).signOut();
    } catch {
      // local-only cleanup; ignore
    }
  }
  await clearSession();
}

/**
 * Boot-time restore: resolves the signed-in identity when a usable session
 * exists (refreshing if needed), else null. Never throws.
 */
export async function restoreSession(): Promise<{ email: string; name: string } | null> {
  try {
    const token = await getIdToken();
    if (!token) return null;
    const storedEmail = (await SecureStore.getItemAsync(KEYS.email)) ?? "";
    return decodeIdentity(token, storedEmail);
  } catch {
    return null;
  }
}
