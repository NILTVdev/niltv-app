import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { rateLimitWaitMs } from "./lib/ratelimit";
import { claimReload } from "./lib/reload";
import { retryDelay, shouldRetryRead } from "./lib/retry";
import { ErrorBoundary, sessionStoreOrNull } from "./ui/ErrorBoundary";
import { ToastProvider } from "./ui/Toast";
import "./styles.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Network drops (status 0), 5xx and 429 are temporary and retry with
      // backoff; any other 4xx (signed out, no access, not found) will not fix itself.
      retry: shouldRetryRead,
      retryDelay,
      staleTime: 15_000,
    },
    mutations: {
      // Only a short 429 is sent again: it is refused before the route runs, so it cannot land twice.
      retry: (failureCount, error) => failureCount < 2 && rateLimitWaitMs(error) !== undefined,
      retryDelay: (_failureCount, error) => rateLimitWaitMs(error) ?? 1000,
    },
  },
});

// After a deploy the old build's chunks are gone. Reload once to get the new
// build; if it fails again within a minute, the error screen takes over.
window.addEventListener("vite:preloadError", (event) => {
  if (claimReload(sessionStoreOrNull(), Date.now())) {
    event.preventDefault();
    window.location.reload();
  }
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <App />
        </ToastProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  </StrictMode>,
);
