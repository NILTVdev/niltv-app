/** Email + password (Cognito SRP), and the forgot-password code flow. */
import { type FormEvent, useEffect, useRef, useState } from "react";
import { confirmPassword, forgotPassword, signIn } from "../auth";
import { config } from "../config";

type Mode = "signin" | "forgot" | "reset";

export function SignIn({ onSignedIn }: { onSignedIn: (email: string) => void }) {
  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    document.title = "Sign in | NIL TV Portal";
  }, []);

  const switchTo = (next: Mode, message: string | null = null) => {
    setMode(next);
    setError(null);
    setNotice(message);
    window.setTimeout(() => headingRef.current?.focus(), 0);
  };

  async function run(task: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await task();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const submitSignIn = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => onSignedIn(await signIn(email.trim(), password)));
  };

  const submitForgot = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await forgotPassword(email.trim());
      switchTo("reset", `If ${email.trim()} has a niltv.com account, a code is on its way there.`);
    });
  };

  const submitReset = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await confirmPassword(email.trim(), code.trim(), newPassword);
      setPassword("");
      setCode("");
      setNewPassword("");
      switchTo("signin", "Password changed. Sign in with the new one.");
    });
  };

  const titles: Record<Mode, string> = {
    signin: "Sign in",
    forgot: "Reset your password",
    reset: "Set a new password",
  };

  return (
    <div className="centered">
      <div className="auth">
        <div className="mark">
          <span>
            <b>NIL</b> TV
          </span>
          <small>Portal</small>
          {config.stage !== "prod" ? <span className="stage">{config.stage}</span> : null}
        </div>
        <h1 ref={headingRef} tabIndex={-1}>
          {titles[mode]}
        </h1>
        {mode === "signin" ? <p>Use your niltv.com account.</p> : null}
        {notice ? (
          <p className="okmsg" role="status">
            {notice}
          </p>
        ) : null}
        {error ? (
          <p className="err" role="alert">
            {error}
          </p>
        ) : null}

        {mode === "signin" ? (
          <form className="panel" onSubmit={submitSignIn}>
            <div className="field">
              <label htmlFor="si-email">Email</label>
              <input
                id="si-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="username"
                required
              />
            </div>
            <div className="field">
              <label htmlFor="si-password">Password</label>
              <input
                id="si-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                required
              />
            </div>
            <button className="btn" type="submit" disabled={busy || !email.trim() || !password}>
              {busy ? "Signing in…" : "Sign in"}
            </button>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <button type="button" className="linkbtn" onClick={() => switchTo("forgot")}>
                Forgot password?
              </button>
              <a className="linkbtn" href="https://niltv.com/" target="_blank" rel="noopener noreferrer">
                No niltv.com account? Create one
              </a>
            </div>
          </form>
        ) : null}

        {mode === "forgot" ? (
          <form className="panel" onSubmit={submitForgot}>
            <p className="note">Enter your account email. We send a code to reset the password.</p>
            <div className="field">
              <label htmlFor="fp-email">Email</label>
              <input
                id="fp-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="username"
                required
              />
            </div>
            <button className="btn" type="submit" disabled={busy || !email.trim()}>
              {busy ? "Sending…" : "Send the code"}
            </button>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <button type="button" className="linkbtn" onClick={() => switchTo("signin")}>
                Back to sign in
              </button>
              <button type="button" className="linkbtn" onClick={() => switchTo("reset")}>
                I have a code
              </button>
            </div>
          </form>
        ) : null}

        {mode === "reset" ? (
          <form className="panel" onSubmit={submitReset}>
            <div className="field">
              <label htmlFor="rp-email">Email</label>
              <input
                id="rp-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="username"
                required
              />
            </div>
            <div className="field">
              <label htmlFor="rp-code">Code from the email</label>
              <input
                id="rp-code"
                inputMode="numeric"
                autoComplete="one-time-code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                required
              />
            </div>
            <div className="field">
              <label htmlFor="rp-new">New password</label>
              <input
                id="rp-new"
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                autoComplete="new-password"
                aria-describedby="rp-new-help"
                required
              />
              <span id="rp-new-help" className="hint">
                At least 8 characters with a number, an uppercase and a lowercase letter.
              </span>
            </div>
            <button className="btn" type="submit" disabled={busy || !email.trim() || !code.trim() || !newPassword}>
              {busy ? "Saving…" : "Set new password"}
            </button>
            <div className="row">
              <button type="button" className="linkbtn" onClick={() => switchTo("signin")}>
                Back to sign in
              </button>
            </div>
          </form>
        ) : null}
      </div>
    </div>
  );
}
