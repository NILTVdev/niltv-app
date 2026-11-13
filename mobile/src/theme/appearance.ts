import type { AppearancePreference } from "@niltv/types";

import { themePalettes, type ThemePalette, type ThemeScheme } from "./tokens";

export const APPEARANCE_OPTIONS: readonly {
  value: AppearancePreference;
  label: string;
  description: string;
}[] = [
  { value: "light", label: "Light", description: "Always use light appearance." },
  { value: "dark", label: "Dark", description: "Always use dark appearance." },
  { value: "system", label: "System", description: "Match your device appearance." },
];

export function appearanceLabel(preference: AppearancePreference): string {
  return APPEARANCE_OPTIONS.find((option) => option.value === preference)?.label ?? "System";
}

export function appearanceRadioAccessibilityProps(selected: boolean, disabled: boolean) {
  return {
    accessibilityState: { selected, disabled },
    "aria-checked": selected,
  };
}

export function appearanceSaveErrorMessage(error: unknown): string {
  const details =
    typeof error === "object" && error !== null ? (error as { code?: unknown; status?: unknown }) : undefined;
  if (details?.status === 401 || details?.code === "NO_SESSION") {
    return "Your session has expired. Sign in again to change appearance.";
  }
  if (details?.status === 400 || details?.code === "INVALID_REQUEST") {
    return "That appearance choice is unavailable. Try selecting it again.";
  }
  return "Could not save your appearance. Check your connection and try again.";
}

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