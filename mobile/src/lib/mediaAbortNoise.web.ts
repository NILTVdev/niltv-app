/**
 * expo-video's web adapter fires HTMLMediaElement.play() without ever
 * attaching a catch (VideoPlayer.web.js: play(), replace() — which also
 * auto-plays on every source swap — and _synchronizeWithFirstVideo). Any
 * interruption of that pending play() — a new load, a pause, element removal;
 * all routine in a swipe feed — rejects the dropped promise and lands in the
 * console as an unhandled AbortError. Nothing app-side can reach the promise
 * (player.play() returns void), so the noise is filtered here instead, on
 * BOTH paths it can take to the console:
 *
 *  1. unhandledrejection — the dropped play() promise itself. Installed at
 *     module scope (below) so rejections that fire before the _layout mount
 *     effect runs are caught too.
 *  2. console.error — some code paths (e.g. a library catching and logging
 *     the rejection itself) report the same AbortError directly, so the
 *     unhandledrejection listener never sees it. A narrow console.error wrap
 *     drops ONLY a first argument that is an AbortError about interrupted
 *     play(); everything else passes through untouched.
 *
 * ONLY the interrupted-play() AbortError is suppressed; every other rejection
 * and error still logs. Web-only — the native players have no play() promise
 * to leak. Remove when expo-video catches its own promises upstream.
 */

let installed = false;

function isInterruptedPlayAbort(value: unknown): boolean {
  return (
    (value instanceof DOMException || value instanceof Error) &&
    value.name === "AbortError" &&
    /play\(\) request was interrupted/.test(value.message)
  );
}

export function suppressMediaAbortNoise(): void {
  if (installed) return;
  installed = true;

  window.addEventListener("unhandledrejection", (event) => {
    if (isInterruptedPlayAbort(event.reason)) {
      event.preventDefault();
    }
  });

  const originalError = console.error;
  console.error = function (this: unknown, ...args: unknown[]) {
    if (args.length > 0 && isInterruptedPlayAbort(args[0])) return;
    originalError.apply(this ?? console, args);
  };
}

// Install as soon as the bundle evaluates — the _layout mount effect runs too
// late for rejections fired during startup. Guarded for SSR: the static web
// export executes this bundle in Node, where window does not exist.
if (typeof window !== "undefined") {
  suppressMediaAbortNoise();
}
