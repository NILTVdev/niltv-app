// amazon-cognito-identity-js needs crypto.getRandomValues — MUST load first.
import "react-native-get-random-values";

import {
  BarlowCondensed_700Bold,
  BarlowCondensed_800ExtraBold,
} from "@expo-google-fonts/barlow-condensed";
import { Inter_400Regular, Inter_600SemiBold, Inter_700Bold, useFonts } from "@expo-google-fonts/inter";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import { DarkTheme, Stack, ThemeProvider } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";

import * as SystemUI from "expo-system-ui";

import { persistOptions, queryClient } from "@/api/queryClient";
import { bootstrapAuth, useAuthStore } from "@/auth/store";
import { InterestSheet } from "@/components/InterestSheet";
import { OfflineBanner } from "@/components/OfflineBanner";
import { suppressMediaAbortNoise } from "@/lib/mediaAbortNoise";
import { wireNetworkManagers } from "@/lib/network";
import { refreshRegistrationIfGranted } from "@/push";
import { PushDeepLinks } from "@/push/DeepLinks";
import { installErrorReporting } from "@/telemetry/errors";

SplashScreen.preventAutoHideAsync();
// Fade the splash into the app instead of a hard cut (colors now match:
// splash bg == app bg == #060608, so the handoff is invisible).
SplashScreen.setOptions({ duration: 350, fade: true });

export default function RootLayout() {
  const signedIn = useAuthStore((s) => s.status === "signedIn");
  const [fontsLoaded, fontError] = useFonts({
    BarlowCondensed_700Bold,
    BarlowCondensed_800ExtraBold,
    Inter_400Regular,
    Inter_600SemiBold,
    Inter_700Bold,
  });

  // Restore the Cognito session (SecureStore tokens → refresh if stale) once
  // on boot, and wire react-query's reconnect/foreground signals (mount-only:
  // the static web export renders layouts in Node, where browser globals
  // don't exist).
  useEffect(() => {
    installErrorReporting();
    wireNetworkManagers();
    suppressMediaAbortNoise();
    // Root window color: guards against white flashes behind modal mounts
    // and screen transitions on the dark-only theme.
    void SystemUI.setBackgroundColorAsync("#060608").catch(() => undefined);
    void bootstrapAuth();
  }, []);

  // Tokens rotate across reinstalls — silently re-upload while signed in with
  // permission already granted (never prompts; design §6.2).
  useEffect(() => {
    if (signedIn) void refreshRegistrationIfGranted();
  }, [signedIn]);

  useEffect(() => {
    if (fontsLoaded || fontError) {
      SplashScreen.hideAsync();
    }
  }, [fontsLoaded, fontError]);

  if (!fontsLoaded && !fontError) {
    return null;
  }

  return (
    <PersistQueryClientProvider client={queryClient} persistOptions={persistOptions}>
      {/* Dark-only network identity. */}
      <ThemeProvider value={DarkTheme}>
        <Stack screenOptions={{ headerShown: false }}>
          <Stack.Screen name="(tabs)" />
          <Stack.Screen name="newsletter" options={{ presentation: "modal" }} />
          <Stack.Screen name="auth" options={{ presentation: "modal" }} />
          {/* Full-screen feed: fade over the push-slide so it feels embedded. */}
          <Stack.Screen name="video/[contentId]" options={{ animation: "fade" }} />
          {/* Theater for the featured horizontal episodes: full-screen, fades like the feed. */}
          <Stack.Screen name="theater" options={{ presentation: "fullScreenModal", animation: "fade" }} />
        </Stack>
        <InterestSheet />
        <PushDeepLinks />
        <OfflineBanner />
        {/* Dark-only app: commit to light icons rather than trusting scheme inference. */}
        <StatusBar style="light" />
      </ThemeProvider>
    </PersistQueryClientProvider>
  );
}
