/**
 * Cognito SRP auth (amazon-cognito-identity-js), same setup as the admin
 * tool. In a browser tab the library keeps the session in `sessionStorage`,
 * so a signed-in tab survives a reload but not a browser restart. Opened as
 * the installed app (from the Home Screen), it keeps the session in
 * `localStorage` instead, so closing the app does not sign people out.
 * Signing out clears the session from both. `getIdToken()` refreshes an
 * expired session through the refresh token.
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
  CognitoUser,
  CognitoUserAttribute,
  CognitoUserPool,
  type CognitoUserSession,
} from "amazon-cognito-identity-js";
import { config } from "./config";
import { runningStandalone } from "./lib/push";

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

/** Restore the saved session. Resolves to the email, or null when signed out. */
export function restoreSession(): Promise<string | null> {
  return new Promise((resolve) => {
    const user = getPool().getCurrentUser();
    if (!user) {
      resolve(null);
      return;
    }
    user.getSession((err: Error | null, session: CognitoUserSession | null) => {
      if (err || !session || !session.isValid()) {
        resolve(null);
        return;
      }
      resolve(emailOf(session, user.getUsername()));
    });
  });
}

/** Current ID-token JWT, refreshing if expired. Rejects with NotSignedInError when signed out. */
export function getIdToken(): Promise<string> {
  return new Promise((resolve, reject) => {
    const user = getPool().getCurrentUser();
    if (!user) {
      reject(new NotSignedInError());
      return;
    }
    user.getSession((err: Error | null, session: CognitoUserSession | null) => {
      if (err || !session || !session.isValid()) {
        reject(new NotSignedInError());
        return;
      }
      resolve(session.getIdToken().getJwtToken());
    });
  });
}

/**
 * Sign out here, and drop this app client's tokens from both storages: a
 * session saved by the installed app must not outlive a sign-out in a tab.
 */
export function signOut(): void {
  try {
    getPool().getCurrentUser()?.signOut();
  } catch {
    /* not configured: nothing to sign out of */
  }
  const prefix = `CognitoIdentityServiceProvider.${config.cognito.clientId ?? ""}.`;
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
