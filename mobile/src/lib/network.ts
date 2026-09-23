import { focusManager, onlineManager } from "@tanstack/react-query";
import * as Network from "expo-network";
import { AppState, Platform } from "react-native";

/**
 * Wire react-query's managers to the platform (design §3.2 offline behavior).
 * Without this, React Native never signals reconnect/foreground, so
 * refetchOnReconnect and refetchOnWindowFocus are dead switches: a query that
 * failed offline stays failed until its screen remounts. Called once from a
 * mount effect (never during render/SSR — the static web export runs layouts
 * in Node, where browser globals don't exist). Web keeps the browser defaults.
 */
export function wireNetworkManagers(): void {
  if (Platform.OS === "web") return;

  onlineManager.setEventListener((setOnline) => {
    const subscription = Network.addNetworkStateListener((state) => {
      // Unknown (undefined) counts as online — only a definite "no" pauses queries.
      setOnline(state.isConnected !== false);
    });
    return () => subscription.remove();
  });

  AppState.addEventListener("change", (status) => {
    focusManager.setFocused(status === "active");
  });
}
