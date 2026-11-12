import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { PortalApiError } from "./api";
import { App } from "./App";
import { rateLimitWaitMs } from "./lib/ratelimit";
import { ToastProvider } from "./ui/Toast";
import "./styles.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // A 4xx (signed out, no access, not found) will not fix itself. Network
      // drops (status 0), 5xx and a short 429 get two more tries.
      retry: (failureCount, error) =>
        failureCount < 2 &&
        (rateLimitWaitMs(error) !== undefined ||
          !(error instanceof PortalApiError && error.status >= 400 && error.status < 500)),
      retryDelay: (failureCount, error) => rateLimitWaitMs(error) ?? Math.min(1000 * 2 ** failureCount, 30_000),
      staleTime: 15_000,
    },
    mutations: {
      // A 429 is refused before the route runs, so sending the same write again is safe.
      // Anything else surfaces at once, as before.
      retry: (failureCount, error) => failureCount < 2 && rateLimitWaitMs(error) !== undefined,
      retryDelay: (_failureCount, error) => rateLimitWaitMs(error) ?? 1000,
    },
  },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <App />
      </ToastProvider>
    </QueryClientProvider>
  </StrictMode>,
);
