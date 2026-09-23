import { tokens } from "./tokens";

/**
 * The network look (dark-only): one committed identity
 * matching niltv.com's redesign — near-black grounds, gold accents. `dark`
 * stays in the shape so existing scheme branches keep working; it is always
 * true now.
 */
export function useTheme() {
  return {
    dark: true,
    /** screen background */
    bg: "#060608",
    /** cards / sheets */
    surface: "#17171c",
    /** inset surfaces (segmented track, avatar wells) */
    inset: "#212127",
    text: "#f5f5f7",
    subtext: "#a8a8b3",
    line: "#26262c",
    /** gold accent */
    accent: tokens.color.gold,
  } as const;
}

export type Theme = ReturnType<typeof useTheme>;
