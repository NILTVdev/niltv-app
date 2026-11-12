/** Email + password (Cognito SRP), creating an account, and the code flows. */
import { type FormEvent, useEffect, useRef, useState } from "react";
import { NotConfirmedError, confirmPassword, confirmSignUp, forgotPassword, resendCode, signIn, signUp } from "../auth";
import { MIN_AGE, ageOn, inviteFromUrl } from "../lib/signup";
import { LegalLinks, PRIVACY_URL, TERMS_URL } from "../ui/bits";
import { Mark } from "../ui/Brand";

type Mode = "signin" | "forgot" | "reset" | "create" | "confirm";

const PASSWORD_HINT = "At least 8 characters with a number, an uppercase and a lowercase letter.";

/** `notice` explains why sign-in is showing, such as a session that ended. */
export function SignIn({ onSignedIn, notice: initialNotice }: { onSignedIn: (email: string) => void; notice?: string }) {
  const [invite] = useState(() => inviteFromUrl(window.location.pathname, window.location.search));
  const [mode, setMode] = useState<Mode>(invite.create ? "create" : "signin");
  const [email, setEmail] = useState(invite.email);
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [birthdate, setBirthdate] = useState("");
  const [code, setCode] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(initialNotice ?? null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  const titles: Record<Mode, string> = {
    signin: "Sign in",
    forgot: "Reset your password",
    reset: "Set a new password",
    create: "Create your account",
    confirm: "Check your email",
  };

  useEffect(() => {
    document.title = `${titles[mode]} | NIL TV Portal`;
  });

  /** Signed in: the invite link has done its job, so it must not reopen Create after a sign-out. */
  const finish = (signedIn: string) => {
    if (invite.create) window.history.replaceState(null, "", "/");
    onSignedIn(signedIn);
  };

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
    void run(async () => {
      try {
        finish(await signIn(email, password));
      } catch (err) {
        if (!(err instanceof NotConfirmedError)) throw err;
        switchTo("confirm", "This account is not confirmed yet. Enter the code from your email, or send a new one.");
      }
    });
  };

  const submitCreate = (e: FormEvent) => {
    e.preventDefault();
    setNotice(null);
    const age = ageOn(birthdate, new Date());
    if (age === null) return setError("Enter your birthdate.");
    if (age < MIN_AGE) return setError(`The portal is for people ${MIN_AGE} and older.`);
    void run(async () => {
      await signUp({ email, password, name, birthdate });
      switchTo("confirm", `We sent a code to ${email.trim()}.`);
    });
  };

  const submitConfirm = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await confirmSignUp(email, code);
      setCode("");
      try {
        finish(await signIn(email, password));
      } catch {
        switchTo("signin", "Account confirmed. Sign in.");
      }
    });
  };

  const sendNewCode = () => {
    void run(async () => {
      await resendCode(email);
      setNotice(`A new code is on its way to ${email.trim()}.`);
    });
  };

  const submitForgot = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await forgotPassword(email);
      switchTo("reset", `If ${email.trim()} has a niltv.com account, a code is on its way there.`);
    });
  };

  const submitReset = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await confirmPassword(email, code.trim(), newPassword);
      setPassword("");
      setCode("");
      setNewPassword("");
      switchTo("signin", "Password changed. Sign in with the new one.");
    });
  };

  return (
    <div className="centered">
      <div className="auth">
        <Mark tagline />
        <span className="slash" aria-hidden="true" />
        <h1 ref={headingRef} tabIndex={-1}>
          {titles[mode]}
        </h1>
        {mode === "signin" ? <p>Use your niltv.com account.</p> : null}
        {mode === "create" ? <p>Athletes: use the email from your NIL TV application.</p> : null}
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
              <button type="button" className="linkbtn" onClick={() => switchTo("create")}>
                No account yet? Create one
              </button>
            </div>
          </form>
        ) : null}

        {mode === "create" ? (
          <form className="panel" onSubmit={submitCreate}>
            <div className="field">
              <label htmlFor="ca-name">Name</label>
              <input
                id="ca-name"
                value={name}
                maxLength={80}
                onChange={(e) => setName(e.target.value)}
                autoComplete="name"
                required
              />
            </div>
            <div className="field">
              <label htmlFor="ca-email">Email</label>
              <input
                id="ca-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="username"
                required
              />
            </div>
            <div className="field">
              <label htmlFor="ca-birthdate">Birthdate</label>
              <input
                id="ca-birthdate"
                type="date"
                value={birthdate}
                onChange={(e) => setBirthdate(e.target.value)}
                autoComplete="bday"
                required
              />
            </div>
            <div className="field">
              <label htmlFor="ca-password">Password</label>
              <input
                id="ca-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password"
                aria-describedby="ca-password-help"
                required
              />
              <span id="ca-password-help" className="hint">
                {PASSWORD_HINT}
              </span>
            </div>
            <p className="note">
              By creating an account you agree to the{" "}
              <a href={TERMS_URL} target="_blank" rel="noopener noreferrer">
                Terms of Use
              </a>{" "}
              and{" "}
              <a href={PRIVACY_URL} target="_blank" rel="noopener noreferrer">
                Privacy Policy
              </a>
              .
            </p>
            <button className="btn" type="submit" disabled={busy || !name.trim() || !email.trim() || !birthdate || !password}>
              {busy ? "Creating…" : "Create account"}
            </button>
            <div className="row">
              <button type="button" className="linkbtn" onClick={() => switchTo("signin")}>
                Have an account? Sign in
              </button>
            </div>
          </form>
        ) : null}

        {mode === "confirm" ? (
          <form className="panel" onSubmit={submitConfirm}>
            <div className="field">
              <label htmlFor="cc-code">Code from the email</label>
              <input
                id="cc-code"
                inputMode="numeric"
                autoComplete="one-time-code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                required
              />
            </div>
            <button className="btn" type="submit" disabled={busy || !code.trim()}>
              {busy ? "Confirming…" : "Confirm"}
            </button>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <button type="button" className="linkbtn" disabled={busy} onClick={sendNewCode}>
                Send a new code
              </button>
              <button type="button" className="linkbtn" onClick={() => switchTo("signin")}>
                Back to sign in
              </button>
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
                {PASSWORD_HINT}
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

        <LegalLinks />
      </div>
    </div>
  );
}
