import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { PortalApiError } from "./api";
import { App } from "./App";
import { applyLook } from "./lib/look";
import { ToastProvider } from "./ui/Toast";
import "./styles.css";

applyLook();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // A 4xx (signed out, no access, not found) will not fix itself. Network
      // drops (status 0) and 5xx get two more tries.
      retry: (failureCount, error) =>
        !(error instanceof PortalApiError && error.status >= 400 && error.status < 500) && failureCount < 2,
      staleTime: 15_000,
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
