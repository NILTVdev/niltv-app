import { createContext, useContext } from "react";

import type { ThemePalette } from "./tokens";

export const ThemeContext = createContext<ThemePalette | null>(null);

export function useTheme(): ThemePalette {
  const theme = useContext(ThemeContext);
  if (!theme) throw new Error("useTheme must be used within AppearanceProvider");
  return theme;
}

export type Theme = ThemePalette;
