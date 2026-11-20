import { useMe } from "@/api/hooks";
import { useAuthStore } from "@/auth/store";
import { Appearance, Platform, useColorScheme } from "react-native";
import { DefaultTheme, DarkTheme, ThemeProvider as RouterThemeProvider } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect, type PropsWithChildren } from "react";
import * as SystemUI from "expo-system-ui";

import { appearanceForSession, paletteForAppearance, resolveAppearance } from "./appearance";
import { ThemeContext } from "./useTheme";

export function AppearanceProvider({ children }: PropsWithChildren) {
  const authStatus = useAuthStore((state) => state.status);
  const me = useMe();
  const preference = appearanceForSession(authStatus === "signedIn", me.data?.appearance);
  const nativeScheme = useColorScheme();
  const deviceScheme = nativeScheme === "light" || nativeScheme === "dark" ? nativeScheme : null;
  const scheme = resolveAppearance(preference, deviceScheme);
  const palette = paletteForAppearance(preference, deviceScheme);

  useEffect(() => {
    if (Platform.OS === "web") return;
    // React Native 0.86 uses "unspecified" to clear the app-level override.
    Appearance.setColorScheme(preference === undefined || preference === "system" ? "unspecified" : preference);
  }, [preference]);

  useEffect(() => {
    void SystemUI.setBackgroundColorAsync(palette.bg).catch(() => undefined);
  }, [palette.bg]);

  const navigationTheme = scheme === "dark" ? DarkTheme : DefaultTheme;

  return (
    <ThemeContext.Provider value={palette}>
      <RouterThemeProvider
        value={{
          ...navigationTheme,
          dark: palette.dark,
          colors: {
            ...navigationTheme.colors,
            primary: palette.accent,
            background: palette.bg,
            card: palette.surface,
            text: palette.text,
            border: palette.line,
            notification: palette.accent,
          },
        }}
      >
        {children}
        <StatusBar style={palette.dark ? "light" : "dark"} />
      </RouterThemeProvider>
    </ThemeContext.Provider>
  );
}