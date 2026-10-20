/**
 * Cognito SRP auth (amazon-cognito-identity-js), same setup as the admin
 * tool: the library keeps the session in `sessionStorage`, so a signed-in
 * tab survives a reload but not a browser restart. `getIdToken()` refreshes
 * an expired session through the refresh token.
 *
 * Portal accounts are ordinary niltv.com accounts; the portal API decides
 * who gets in (403 NOT_MEMBER), not Cognito.
 */
import {
  AuthenticationDetails,
  CognitoUser,
  CognitoUserPool,
  type CognitoUserSession,
} from "amazon-cognito-identity-js";
import { config } from "./config";

let pool: CognitoUserPool | undefined;

function getPool(): CognitoUserPool {
  if (!pool) {
    const { userPoolId, clientId } = config.cognito;
    if (!userPoolId || !clientId) throw new Error("Cognito is not configured.");
    pool = new CognitoUserPool({ UserPoolId: userPoolId, ClientId: clientId, Storage: window.sessionStorage });
  }
  return pool;
}

const userFor = (email: string): CognitoUser =>
  new CognitoUser({ Username: email, Pool: getPool(), Storage: window.sessionStorage });

export class NotSignedInError extends Error {
  constructor() {
    super("Not signed in.");
    this.name = "NotSignedInError";
  }
}

/** Cognito error codes in plain words. */
function friendly(err: unknown): Error {
  const code = (err as { code?: string; name?: string } | undefined)?.code ?? (err as { name?: string } | undefined)?.name;
  const raw =
    err instanceof Error ? err.message : String((err as { message?: string } | undefined)?.message ?? err ?? "");
  switch (code) {
    case "NotAuthorizedException":
      return new Error("That email and password do not match.");
    case "UserNotFoundException":
      return new Error("That email and password do not match.");
    case "UserNotConfirmedException":
      return new Error("This account is not confirmed yet. Finish signing up on niltv.com first.");
    case "CodeMismatchException":
      return new Error("That code is not right. Check the email and try again.");
    case "ExpiredCodeException":
      return new Error("That code has expired. Ask for a new one.");
    case "InvalidPasswordException":
      return new Error(raw.replace(/^Password does not conform to policy: /, "") || "That password is not strong enough.");
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

/** SRP sign-in. Resolves to the signed-in email. */
export function signIn(email: string, password: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const user = userFor(email);
    user.authenticateUser(new AuthenticationDetails({ Username: email, Password: password }), {
      onSuccess: (session) => resolve(emailOf(session, email)),
      onFailure: (err: unknown) => reject(friendly(err)),
      newPasswordRequired: () => {
        reject(new Error("This account needs a new password. Use Forgot password to set one."));
      },
    });
  });
}

/** Email a reset code. */
export function forgotPassword(email: string): Promise<void> {
  return new Promise((resolve, reject) => {
    userFor(email).forgotPassword({
      onSuccess: () => resolve(),
      onFailure: (err: unknown) => reject(friendly(err)),
      inputVerificationCode: () => resolve(),
    });
  });
}

/** Set a new password with the emailed code. */
export function confirmPassword(email: string, code: string, newPassword: string): Promise<void> {
  return new Promise((resolve, reject) => {
    userFor(email).confirmPassword(code, newPassword, {
      onSuccess: () => resolve(),
      onFailure: (err: unknown) => reject(friendly(err)),
    });
  });
}

/** Restore a session from sessionStorage. Resolves to the email, or null when signed out. */
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

export function signOut(): void {
  try {
    getPool().getCurrentUser()?.signOut();
  } catch {
    /* not configured: nothing to sign out of */
  }
}
