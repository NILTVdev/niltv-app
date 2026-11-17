/**
 * Catches render errors and failed screen loads anywhere in the app, so a
 * crash shows a short message and a Reload button instead of a blank page.
 * A missing chunk after a deploy reloads once on its own (lib/reload.ts).
 */
import { Component, type ErrorInfo, type ReactNode } from "react";
import { claimReload, fallbackCopy, isChunkError } from "../lib/reload";

export function sessionStoreOrNull(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export function ErrorFallback({ error, onReload }: { error: unknown; onReload: () => void }) {
  const copy = fallbackCopy(error);
  return (
    <div className="centered">
      <div className="auth" role="alert">
        <h1>{copy.title}</h1>
        <div className="panel">
          <p>{copy.text}</p>
          <div className="row">
            <button type="button" className="btn" onClick={onReload}>
              Reload
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export class ErrorBoundary extends Component<{ children: ReactNode }, { error: unknown; failed: boolean }> {
  state = { error: undefined as unknown, failed: false };

  static getDerivedStateFromError(error: unknown) {
    return { error, failed: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error("portal: render error", error, info.componentStack);
    if (isChunkError(error) && claimReload(sessionStoreOrNull(), Date.now())) window.location.reload();
  }

  render() {
    if (this.state.failed) return <ErrorFallback error={this.state.error} onReload={() => window.location.reload()} />;
    return this.props.children;
  }
}
