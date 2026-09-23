/**
 * Display-title sizing that never truncates (hero and page titles
 * must fit the phone, never ellipsize). adjustsFontSizeToFit is unreliable
 * with explicit line breaks on Android, so the size is computed up front from
 * the longest line: Barlow Condensed 800 uppercase averages about 0.5em per
 * glyph, 0.55 keeps a margin for wide letters (M, W) and tracking. The
 * caller still passes adjustsFontSizeToFit as a last guard.
 */
const GLYPH_EM = 0.55;

export function fitDisplaySize(text: string, availableWidth: number, max: number, min = 16): number {
  const longest = text.split("\n").reduce((n, line) => Math.max(n, line.trim().length), 0);
  if (longest === 0 || availableWidth <= 0) return max;
  const fitted = Math.floor(availableWidth / (longest * GLYPH_EM));
  return Math.max(min, Math.min(max, fitted));
}
