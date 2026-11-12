import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ErrorFallback } from "../ui/ErrorBoundary";
import { RELOAD_KEY, RELOAD_WINDOW_MS, claimReload, fallbackCopy, isChunkError } from "./reload";

const memory = () => {
  const data = new Map<string, string>();
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  };
};

const now = 1_800_000_000_000;

describe("claimReload", () => {
  it("allows one reload, then refuses inside the window", () => {
    const store = memory();
    expect(claimReload(store, now)).toBe(true);
    expect(store.getItem(RELOAD_KEY)).toBe(String(now));
    expect(claimReload(store, now + 2000)).toBe(false);
    expect(claimReload(store, now + RELOAD_WINDOW_MS - 1)).toBe(false);
  });

  it("allows another reload once the window has passed", () => {
    const store = memory();
    expect(claimReload(store, now)).toBe(true);
    expect(claimReload(store, now + RELOAD_WINDOW_MS)).toBe(true);
  });

  it("never reloads without working storage", () => {
    expect(claimReload(null, now)).toBe(false);
    const blocked = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {},
    };
    expect(claimReload(blocked, now)).toBe(false);
  });

  it("ignores a junk stamp", () => {
    const store = memory();
    store.setItem(RELOAD_KEY, "nonsense");
    expect(claimReload(store, now)).toBe(true);
  });
});

describe("isChunkError", () => {
  it("knows the browsers' chunk failures", () => {
    expect(isChunkError(new TypeError("Failed to fetch dynamically imported module: https://x/assets/Account-1.js"))).toBe(true);
    expect(isChunkError(new TypeError("Importing a module script failed."))).toBe(true);
    expect(isChunkError(new Error("error loading dynamically imported module"))).toBe(true);
    expect(isChunkError(new Error("Unable to preload CSS for /assets/x.css"))).toBe(true);
  });

  it("leaves other errors alone", () => {
    expect(isChunkError(new TypeError("Cannot read properties of undefined"))).toBe(false);
    expect(isChunkError(undefined)).toBe(false);
  });
});

describe("error fallback", () => {
  it("says the portal updated after a missing chunk", () => {
    expect(fallbackCopy(new TypeError("Importing a module script failed.")).title).toBe("The portal was updated");
  });

  it("renders a short message and a Reload button", () => {
    const html = renderToStaticMarkup(<ErrorFallback error={new Error("boom")} onReload={() => {}} />);
    expect(html).toContain("Something went wrong");
    expect(html).toContain('role="alert"');
    expect(html).toContain('class="btn"');
    expect(html).toContain(">Reload<");
    expect(html).not.toContain("boom");
  });
});
