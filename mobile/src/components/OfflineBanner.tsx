import { Ionicons } from "@expo/vector-icons";
import { useNetworkState } from "expo-network";
import { StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { tokens } from "@/theme/tokens";

/**
 * Slim floating pill shown while the device is definitely offline (design
 * §3.2: offline banner + cached-content browsing). Overlays instead of
 * shifting layout, so full-screen surfaces (the video feed's paging math)
 * are unaffected. Cached screens keep working underneath; reconnect refetch
 * comes from the onlineManager wiring in lib/network.
 */
export function OfflineBanner() {
  const insets = useSafeAreaInsets();
  const network = useNetworkState();
  // undefined = not yet known — never flash the banner on a cold start.
  if (network.isConnected !== false) return null;

  return (
    <View
      style={[styles.wrap, { top: insets.top + tokens.spacing.sm }]}
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
    >
      <View style={styles.pill}>
        <Ionicons name="cloud-offline-outline" size={14} color="#ffffff" />
        <Text style={styles.label}>No connection. Showing saved content.</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: "absolute",
    left: 0,
    right: 0,
    alignItems: "center",
    zIndex: 10,
    pointerEvents: "none",
  },
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    backgroundColor: "rgba(26,26,31,0.92)",
    borderRadius: 999,
    paddingVertical: 7,
    paddingHorizontal: 14,
  },
  label: {
    color: "#ffffff",
    fontFamily: tokens.font.semibold,
    fontSize: 12,
  },
});
