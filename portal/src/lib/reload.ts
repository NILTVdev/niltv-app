/**
 * Recovering from a deploy: a screen's code chunk from the old build is gone,
 * so the page reloads once to pick up the new build. The time of the last
 * automatic reload sits in sessionStorage, so a chunk that is still missing
 * after the reload shows the error screen instead of reloading forever.
 */

export const RELOAD_KEY = "niltv-portal:auto-reload-at";

/** No second automatic reload within this window. */
export const RELOAD_WINDOW_MS = 60_000;

type Store = Pick<Storage, "getItem" | "setItem">;

/**
 * True when an automatic reload may happen now, and records it. False when
 * one happened in the last minute, or when storage is blocked (with no guard
 * a reload could loop, so the error screen's button is the way out).
 */
export function claimReload(store: Store | null, now: number): boolean {
  if (!store) return false;
  try {
    const last = Number(store.getItem(RELOAD_KEY));
    if (Number.isFinite(last) && last > 0 && now - last >= 0 && now - last < RELOAD_WINDOW_MS) return false;
    store.setItem(RELOAD_KEY, String(now));
    return true;
  } catch {
    return false;
  }
}

/** A failed load of a code chunk, in the words Chrome, Safari, Firefox and Vite use. */
export function isChunkError(error: unknown): boolean {
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error ?? "");
  return /dynamically imported module|Importing a module script failed|ChunkLoadError|Unable to preload CSS|Failed to fetch module/i.test(
    text,
  );
}

/**
 * Picks a named export out of a lazily loaded screen module. When the chunk
 * failed and the reload handler swallowed the error, the import resolves to
 * undefined; that becomes a chunk error so the error screen says the portal
 * was updated instead of showing a crash.
 */
export async function pickExport<K extends string, T>(
  load: () => Promise<Record<K, T> | undefined>,
  name: K,
): Promise<{ default: T }> {
  const mod = await load();
  const picked = mod?.[name];
  if (picked === undefined) throw new Error(`Failed to fetch dynamically imported module: ${name}`);
  return { default: picked };
}

/** What the error screen says. */
export function fallbackCopy(error: unknown): { title: string; text: string } {
  if (isChunkError(error)) {
    return { title: "The portal was updated", text: "Reload to get the latest version." };
  }
  return {
    title: "Something went wrong",
    text: "Reload to keep going. If it happens again, write to support@niltv.com.",
  };
}
