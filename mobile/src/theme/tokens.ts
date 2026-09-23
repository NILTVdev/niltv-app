/**
 * Design tokens — the network palette from the web redesign, adopted
 * app-wide with the dark-only look. Do not tweak per-screen.
 */
export const tokens = {
  color: {
    gold: "#d9b25b",
    goldBright: "#f0c96b",
    goldDeep: "#a8853d",
    goldSoft: "#F7EFD6",
    blue: "#00539b",
    ink: "#0c0c10",
    muted: "#a8a8b3",
    line: "#26262c",
    soft: "#17171c",
  },
  radius: 12,
  spacing: {
    xs: 4,
    sm: 8,
    md: 12,
    lg: 16,
    xl: 24,
  },
  /**
   * Type scale (sizes only; families in `font`). The two display tiers are
   * the broadcast voice — event headlines and the prize line. Adopt on touch:
   * new code reads from here, existing hardcoded sizes migrate as screens get
   * their identity pass.
   */
  text: {
    label: 11,
    meta: 13,
    body: 15,
    section: 17,
    title: 22,
    screen: 26,
    display: 34,
    hero: 44,
  },
  /** Motion durations (ms): press feedback / state fades / sheet-scale moves. */
  motion: {
    fast: 120,
    base: 200,
    slow: 320,
  },
  /** Pressed-state scale target for PressableScale. */
  press: {
    scale: 0.97,
  },
  /**
   * Website type pairing (webapp/index.html): Barlow Condensed for display —
   * headings, hero titles, section heads, kickers, stat numerals — and Inter
   * for body, buttons, labels, metadata. Loaded in app/_layout.tsx. The
   * `extrabold` slot IS the display face (every heading keeps working);
   * `display`/`displayBold` are the explicit aliases for new code.
   */
  font: {
    regular: "Inter_400Regular",
    semibold: "Inter_600SemiBold",
    bold: "Inter_700Bold",
    extrabold: "BarlowCondensed_800ExtraBold",
    display: "BarlowCondensed_800ExtraBold",
    displayBold: "BarlowCondensed_700Bold",
  },
} as const;

export type Tokens = typeof tokens;
