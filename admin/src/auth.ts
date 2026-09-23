/**
 * Cognito SRP auth for the staff admin tool (amazon-cognito-identity-js).
 *
 * The library keeps the live session in memory; we hand it `sessionStorage` so a
 * signed-in tab survives a reload without persisting tokens across browser
 * restarts. `getIdToken()` transparently refreshes an expired session via the
 * refresh token (library behavior of `getSession`).
 */
import {
  AuthenticationDetails,
  CognitoUser,
  CognitoUserPool,
  CognitoUserSession,
} from "amazon-cognito-identity-js";
import { config } from "./config";

const pool = new CognitoUserPool({
  UserPoolId: config.cognito.userPoolId,
  ClientId: config.cognito.clientId,
  Storage: window.sessionStorage,
});

export class NotSignedInError extends Error {
  constructor() {
    super("Not signed in.");
    this.name = "NotSignedInError";
  }
}

function emailOf(session: CognitoUserSession, fallback: string): string {
  const email = session.getIdToken().payload["email"];
  return typeof email === "string" && email ? email : fallback;
}

/** SRP sign-in. Resolves to the signed-in email. */
export function signIn(email: string, password: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const user = new CognitoUser({
      Username: email,
      Pool: pool,
      Storage: window.sessionStorage,
    });
    user.authenticateUser(new AuthenticationDetails({ Username: email, Password: password }), {
      onSuccess: (session) => resolve(emailOf(session, email)),
      onFailure: (err: unknown) => {
        const message =
          err instanceof Error
            ? err.message
            : String((err as { message?: string } | undefined)?.message ?? err);
        reject(new Error(message));
      },
      newPasswordRequired: () => {
        reject(
          new Error(
            "This account still has a temporary password. Have an admin set a permanent one " +
              "(aws cognito-idp admin-set-user-password --permanent) and sign in again.",
          ),
        );
      },
    });
  });
}

/** Restore a session from sessionStorage. Resolves to the email, or null when signed out. */
export function restoreSession(): Promise<string | null> {
  return new Promise((resolve) => {
    const user = pool.getCurrentUser();
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
    const user = pool.getCurrentUser();
    if (!user) {
      reject(new NotSignedInError());
      return;
    }
    user.getSession((err: Error | null, session: CognitoUserSession | null) => {
      if (err || !session || !session.isValid()) {
        reject(err ?? new NotSignedInError());
        return;
      }
      resolve(session.getIdToken().getJwtToken());
    });
  });
}

export function signOut(): void {
  pool.getCurrentUser()?.signOut();
}
