/**
 * Design tokens — the network palette from the web redesign. Keep semantic
 * light/dark surfaces in themePalettes and brand/media colors here.
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

export type ThemeScheme = "light" | "dark";

export interface ThemePalette {
  dark: boolean;
  bg: string;
  surface: string;
  inset: string;
  text: string;
  subtext: string;
  line: string;
  accent: string;
  danger: string;
  onAccent: string;
  raisedSurface: string;
}

export const themePalettes: Record<ThemeScheme, ThemePalette> = {
  dark: {
    dark: true,
    bg: "#060608",
    surface: "#17171c",
    inset: "#212127",
    text: "#f5f5f7",
    subtext: "#a8a8b3",
    line: "#26262c",
    accent: tokens.color.gold,
    danger: "#d97970",
    onAccent: "#1a1a1f",
    raisedSurface: "#3d3d45",
  },
  light: {
    dark: false,
    bg: "#f6f6f8",
    surface: "#ffffff",
    inset: "#ececf0",
    text: "#16161a",
    subtext: "#53535d",
    line: "#8c8c95",
    accent: "#76560f",
    danger: "#a6342b",
    onAccent: "#1a1a1f",
    raisedSurface: "#ffffff",
  },
};
