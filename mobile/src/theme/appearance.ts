import type { AppearancePreference } from "@niltv/types";

import { themePalettes, type ThemePalette, type ThemeScheme } from "./tokens";

export function resolveAppearance(
  preference: AppearancePreference | undefined,
  systemScheme: ThemeScheme | null,
): ThemeScheme {
  const selected = preference ?? "system";
  if (selected !== "system") return selected;
  return systemScheme ?? "light";
}

export function appearanceForSession(
  signedIn: boolean,
  savedPreference: AppearancePreference | undefined,
): AppearancePreference | undefined {
  return signedIn ? savedPreference : undefined;
}

export function paletteForAppearance(
  preference: AppearancePreference | undefined,
  systemScheme: ThemeScheme | null,
): ThemePalette {
  return themePalettes[resolveAppearance(preference, systemScheme)];
}