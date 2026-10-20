/** Signed in to niltv.com, but no portal access (403 NOT_MEMBER). */
import { useEffect } from "react";

export function NoAccess({ email, onSignOut }: { email: string; onSignOut: () => void }) {
  useEffect(() => {
    document.title = "No access yet | NIL TV Portal";
  }, []);
  return (
    <div className="centered">
      <div className="auth">
        <div className="mark">
          <span>
            <b>NIL</b> TV
          </span>
          <small>Portal</small>
        </div>
        <h1>No portal access yet</h1>
        <div className="panel">
          <p>
            You are signed in as <b>{email}</b>, but this account does not have access to the NIL TV Portal.
          </p>
          <p>Athletes get access once their onboarding is complete. The team turns it on for you.</p>
          <p>
            Questions? Write to <a href="mailto:support@niltv.com">support@niltv.com</a>.
          </p>
          <div className="row">
            <button type="button" className="btn ghost" onClick={onSignOut}>
              Sign out
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
