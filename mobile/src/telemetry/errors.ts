/**
 * Global JS error capture → telemetry: release builds have no
 * crash reporting, so a thrown error renders as a dead black screen with no
 * trace. Errors ride
 * the existing telemetry pipeline as `js_error` events and flush immediately —
 * a fatal error may never get another tick. Chains to the previous handler so
 * dev redbox and RN's own fatal handling stay intact.
 */
import { flush, track } from "./index";

type GlobalErrorHandler = (error: unknown, isFatal?: boolean) => void;
type ErrorUtilsLike = {
  getGlobalHandler?: () => GlobalErrorHandler | undefined;
  setGlobalHandler?: (handler: GlobalErrorHandler) => void;
};

export function installErrorReporting(): void {
  const errorUtils = (globalThis as { ErrorUtils?: ErrorUtilsLike }).ErrorUtils;
  if (!errorUtils?.setGlobalHandler) return; // web export / tests
  const previous = errorUtils.getGlobalHandler?.();
  errorUtils.setGlobalHandler((error, isFatal) => {
    try {
      const shaped = error as { message?: unknown; stack?: unknown } | undefined;
      track("js_error", {
        fatal: isFatal === true,
        message: String(shaped?.message ?? error).slice(0, 500),
        stack: String(shaped?.stack ?? "").slice(0, 1500),
      });
      void flush();
    } catch {
      // Reporting must never make a crash worse.
    }
    previous?.(error, isFatal);
  });
}
