/** Signed in to niltv.com, but no portal access (403 NOT_MEMBER). */
import { useEffect } from "react";
import { LegalLinks } from "../ui/bits";
import { Mark } from "../ui/Brand";

export function NoAccess({ email, onSignOut }: { email: string; onSignOut: () => void }) {
  useEffect(() => {
    document.title = "No access yet | NIL TV Portal";
  }, []);
  return (
    <div className="centered">
      <div className="auth">
        <Mark />
        <h1>No portal access yet</h1>
        <div className="panel">
          <p>
            You are signed in as <b>{email}</b>, but this account does not have portal access yet.
          </p>
          <p>
            If you are an accepted athlete, this must be the email from your application. We check for new accounts every
            30 minutes, and the team turns access on.
          </p>
          <div className="row">
            <button type="button" className="btn ghost" onClick={onSignOut}>
              Sign out
            </button>
          </div>
        </div>
        <LegalLinks />
      </div>
    </div>
  );
}
