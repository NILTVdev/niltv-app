/**
 * The look of the main area while the white version is on trial. "light" is a
 * black sidebar with a white main area, "dark" is black throughout. Adding
 * `?look=dark` to any URL switches it, and this browser remembers. styles.css
 * keys off data-look on <html>.
 */
export type Look = "light" | "dark";

const KEY = "niltv-portal:look";

const isLook = (value: string | null): value is Look => value === "light" || value === "dark";

/** The URL wins, then what this browser remembered, then the default. */
export const pickLook = (fromUrl: string | null, stored: string | null): Look =>
  isLook(fromUrl) ? fromUrl : isLook(stored) ? stored : "light";

export function applyLook(): void {
  const fromUrl = new URLSearchParams(window.location.search).get("look");
  let stored: string | null = null;
  try {
    stored = window.localStorage.getItem(KEY);
    if (isLook(fromUrl)) window.localStorage.setItem(KEY, fromUrl);
  } catch {
    /* storage blocked: the default look, or this page's URL */
  }
  document.documentElement.dataset.look = pickLook(fromUrl, stored);
}
