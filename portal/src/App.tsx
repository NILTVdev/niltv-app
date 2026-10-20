/**
 * Setup check → session → portal membership (GET /v1/me) → the portal.
 * A 403 NOT_MEMBER at any point shows the no-access screen; a 401 signs out.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";
import { api, isApiError, onUnauthorized } from "./api";
import { restoreSession, signOut } from "./auth";
import { missingConfig } from "./config";
import { Portal } from "./Portal";
import { ME_POLL_MS, qk } from "./queries";
import { NoAccess } from "./screens/NoAccess";
import { SignIn } from "./screens/SignIn";
import { ErrorNote } from "./ui/bits";
import { MeProvider } from "./ui/me";

export function App() {
  const missing = missingConfig();
  return missing.length > 0 ? <SetupScreen missing={missing} /> : <AuthGate />;
}

/** Shown when the env is incomplete. No request is ever fired. */
function SetupScreen({ missing }: { missing: string[] }) {
  useEffect(() => {
    document.title = "Setup needed | NIL TV Portal";
  }, []);
  return (
    <div className="centered">
      <div className="auth">
        <h1>Setup needed</h1>
        <div className="panel">
          <p>This build of the portal is missing its configuration.</p>
          <p>
            Create <code>portal/.env.local</code> from <code>portal/.env.example</code> and set:
          </p>
          <ul>
            {missing.map((name) => (
              <li key={name}>
                <code>{name}</code>
              </li>
            ))}
          </ul>
          <p className="note">
            Then restart the dev server: <code>npm run dev -w @niltv/portal</code>
          </p>
        </div>
      </div>
    </div>
  );
}

function Splash({ text = "Loading" }: { text?: string }) {
  return (
    <div className="centered">
      <p className="loading" role="status">
        {text}…
      </p>
    </div>
  );
}

function AuthGate() {
  /** undefined = restoring from sessionStorage, null = signed out */
  const [email, setEmail] = useState<string | null | undefined>(undefined);
  const qc = useQueryClient();

  const signOutNow = useCallback(() => {
    signOut();
    qc.clear();
    setEmail(null);
  }, [qc]);

  useEffect(() => {
    onUnauthorized(signOutNow);
    return () => onUnauthorized(undefined);
  }, [signOutNow]);

  useEffect(() => {
    void restoreSession().then(setEmail);
  }, []);

  if (email === undefined) return <Splash />;
  if (email === null) return <SignIn onSignedIn={setEmail} />;
  return <MemberGate email={email} signOut={signOutNow} />;
}

function MemberGate({ email, signOut: doSignOut }: { email: string; signOut: () => void }) {
  const me = useQuery({ queryKey: qk.me, queryFn: api.me, refetchInterval: ME_POLL_MS });

  // Access removed while the tab is open: the next poll returns NOT_MEMBER.
  if (isApiError(me.error, "NOT_MEMBER")) return <NoAccess email={email} onSignOut={doSignOut} />;
  if (me.data) {
    return (
      <MeProvider member={me.data.member} unread={me.data.unreadMessages} signOut={doSignOut}>
        <Portal />
      </MeProvider>
    );
  }
  if (me.isPending) return <Splash text="Opening the portal" />;
  return (
    <div className="centered">
      <div className="auth">
        <h1>Could not open the portal</h1>
        <ErrorNote error={me.error} onRetry={() => void me.refetch()} />
        <div className="row">
          <button type="button" className="btn ghost" onClick={doSignOut}>
            Sign out
          </button>
        </div>
      </div>
    </div>
  );
}
