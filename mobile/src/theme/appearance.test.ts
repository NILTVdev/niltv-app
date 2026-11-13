import { describe, expect, it } from "vitest";

import {
  APPEARANCE_OPTIONS,
  appearanceForSession,
  appearanceLabel,
  appearanceRadioAccessibilityProps,
  appearanceSaveErrorMessage,
  paletteForAppearance,
  resolveAppearance,
} from "./appearance";
import { themePalettes, tokens } from "./tokens";

function luminance(hex: string): number {
  const channels = hex.match(/[a-f\d]{2}/gi)?.map((channel) => parseInt(channel, 16) / 255);
  if (!channels || channels.length !== 3) throw new Error(`Invalid color: ${hex}`);
  const linear = channels.map((channel) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
}

function contrastRatio(foreground: string, background: string): number {
  const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  const lighter = values[0]!;
  const darker = values[1]!;
  return (lighter + 0.05) / (darker + 0.05);
}

describe("appearance resolution", () => {
  it("offers exactly the three saved appearance preferences", () => {
    expect(APPEARANCE_OPTIONS.map((option) => option.value)).toEqual(["light", "dark", "system"]);
    expect(appearanceLabel("light")).toBe("Light");
    expect(appearanceLabel("dark")).toBe("Dark");
    expect(appearanceLabel("system")).toBe("System");
    expect(APPEARANCE_OPTIONS.find((option) => option.value === "system")?.description).toMatch(/device/i);
  });

  it("provides useful feedback for save errors", () => {
    expect(appearanceSaveErrorMessage({ status: 401 })).toMatch(/session has expired/i);
    expect(appearanceSaveErrorMessage({ code: "INVALID_REQUEST" })).toMatch(/unavailable/i);
    expect(appearanceSaveErrorMessage(new Error("offline"))).toMatch(/check your connection/i);
  });

  it("exposes radio selection for native and web screen readers", () => {
    expect(appearanceRadioAccessibilityProps(true, false)).toEqual({
      accessibilityState: { selected: true, disabled: false },
      "aria-checked": true,
    });
    expect(appearanceRadioAccessibilityProps(false, true)).toEqual({
      accessibilityState: { selected: false, disabled: true },
      "aria-checked": false,
    });
  });

  it("uses the system appearance when preference is system or missing", () => {
    expect(resolveAppearance("system", "dark")).toBe("dark");
    expect(resolveAppearance("system", "light")).toBe("light");
    expect(resolveAppearance(undefined, "dark")).toBe("dark");
    expect(resolveAppearance(undefined, null)).toBe("light");
  });

  it("tracks successive system appearance changes", () => {
    expect(resolveAppearance("system", "dark")).toBe("dark");
    expect(resolveAppearance("system", "light")).toBe("light");
  });

  it("keeps explicit light and dark preferences independent of the system", () => {
    expect(resolveAppearance("light", "dark")).toBe("light");
    expect(resolveAppearance("dark", "light")).toBe("dark");
  });

  it("ignores a previous account preference after sign-out", () => {
    expect(appearanceForSession(false, "dark")).toBeUndefined();
    expect(resolveAppearance(appearanceForSession(false, "dark"), "light")).toBe("light");
    expect(appearanceForSession(true, "dark")).toBe("dark");
  });

  it("provides AA text contrast and keeps the existing dark NILTV palette", () => {
    for (const palette of Object.values(themePalettes)) {
      expect(contrastRatio(palette.text, palette.bg)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(palette.subtext, palette.bg)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(palette.accent, palette.bg)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(palette.accent, palette.surface)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(palette.danger, palette.bg)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(palette.text, palette.surface)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(palette.onAccent, tokens.color.gold)).toBeGreaterThanOrEqual(4.5);
    }
    expect(themePalettes.dark.bg).toBe("#060608");
    expect(themePalettes.dark.surface).toBe("#17171c");
    expect(themePalettes.dark.inset).toBe("#212127");
    expect(themePalettes.dark.text).toBe("#f5f5f7");
    expect(themePalettes.dark.subtext).toBe("#a8a8b3");
    expect(themePalettes.dark.line).toBe(tokens.color.line);
  });

  it("provides at least 3:1 contrast for light palette component boundaries", () => {
    const palette = themePalettes.light;
    expect(contrastRatio(palette.line, palette.bg)).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(palette.line, palette.surface)).toBeGreaterThanOrEqual(3);
  });

  it("selects the matching semantic palette", () => {
    expect(paletteForAppearance("dark", "light")).toBe(themePalettes.dark);
    expect(paletteForAppearance("system", "light")).toBe(themePalettes.light);
  });
});