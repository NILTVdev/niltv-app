import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { restoreSession, signOut } from "./auth";
import { config } from "./config";
import { ContentPage } from "./ContentPage";
import { EventsPage } from "./EventsPage";
import { NewsletterPage } from "./NewsletterPage";
import { ProfilesPage } from "./ProfilesPage";
import { SignIn } from "./SignIn";

export function App() {
  return config.apiBase ? <AuthedApp /> : <SetupScreen />;
}

/** Shown when VITE_ADMIN_API_BASE is missing — no requests are ever fired. */
function SetupScreen() {
  return (
    <div className="centered-screen">
      <div className="auth-card">
        <h1>NILTV Admin — setup needed</h1>
        <p className="sub">The admin API address is not configured.</p>
        <p>
          Create <code>admin/.env.local</code> containing{" "}
          <code>VITE_ADMIN_API_BASE=&lt;AdminApiUrl stack output&gt;</code>, then restart the dev
          server (<code>npm run dev -w @niltv/admin</code>).
        </p>
      </div>
    </div>
  );
}

function AuthedApp() {
  /** undefined = restoring from sessionStorage, null = signed out */
  const [email, setEmail] = useState<string | null | undefined>(undefined);
  const queryClient = useQueryClient();

  useEffect(() => {
    void restoreSession().then(setEmail);
  }, []);

  if (email === undefined) {
    return (
      <div className="centered-screen">
        <p className="hint">Restoring session…</p>
      </div>
    );
  }
  if (email === null) return <SignIn onSignedIn={setEmail} />;

  return (
    <Shell
      email={email}
      onSignOut={() => {
        signOut();
        queryClient.clear();
        setEmail(null);
      }}
    />
  );
}

function Shell({ email, onSignOut }: { email: string; onSignOut: () => void }) {
  const [tab, setTab] = useState<"content" | "profiles" | "events" | "newsletter">("content");
  return (
    <>
      <header className="shell-header">
        <span className="brand">
          NILTV <em>Admin</em>
        </span>
        <span className="spacer" />
        <span className="signed-in">{email}</span>
        <button className="btn" onClick={onSignOut}>
          Sign out
        </button>
      </header>
      <nav className="tabs">
        <button className={tab === "content" ? "active" : ""} onClick={() => setTab("content")}>
          Content
        </button>
        <button className={tab === "profiles" ? "active" : ""} onClick={() => setTab("profiles")}>
          Profiles
        </button>
        <button className={tab === "events" ? "active" : ""} onClick={() => setTab("events")}>
          Events
        </button>
        <button className={tab === "newsletter" ? "active" : ""} onClick={() => setTab("newsletter")}>
          Newsletter
        </button>
      </nav>
      <main>
        {tab === "content" ? (
          <ContentPage />
        ) : tab === "profiles" ? (
          <ProfilesPage />
        ) : tab === "events" ? (
          <EventsPage />
        ) : (
          <NewsletterPage />
        )}
      </main>
    </>
  );
}
