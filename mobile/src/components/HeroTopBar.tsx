/**
 * The app's top bar (logo left, mailbox + ★ right) floated transparent over
 * the full-bleed hero.
 * Absolutely positioned inside the hero wrapper so it scrolls away with the
 * art; the hero's top scrim band carries its legibility. No bar fill, ever.
 */
import { Ionicons } from "@expo/vector-icons";
import { Platform, StyleSheet, View, type TextStyle } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { NiltvLogo } from "@/components/Brand";
import { PressableScale } from "@/components/PressableScale";
import { tokens } from "@/theme/tokens";

export function HeroTopBar({ onMail, onStar }: { onMail: () => void; onStar: () => void }) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.bar, { top: insets.top + tokens.spacing.sm }]}>
      <NiltvLogo height={30} />
      <View style={styles.actions}>
        {/* Newsletter (spec §5.6 topbar entry point). */}
        <PressableScale
          onPress={onMail}
          accessibilityRole="button"
          accessibilityLabel="Newsletter signup"
          hitSlop={8}
          scaleTo={0.88}
        >
          <Ionicons name="mail-outline" size={22} color="#ffffff" style={styles.icon} />
        </PressableScale>
        {/* ★ notification picker (spec §5.7) — gated action for guests. */}
        <PressableScale
          onPress={onStar}
          accessibilityRole="button"
          accessibilityLabel="Notification picker"
          hitSlop={8}
          scaleTo={0.88}
        >
          <Ionicons name="star-outline" size={22} color="#ffffff" style={styles.icon} />
        </PressableScale>
      </View>
    </View>
  );
}

// Same shadow either way; RNW 0.21 deprecates the textShadow* long-hand in
// favor of the CSS textShadow short-hand (not in RN's TextStyle type).
const iconShadow: TextStyle = Platform.select<TextStyle>({
  web: { textShadow: "0 1px 4px rgba(6,6,8,0.6)" } as unknown as TextStyle,
  default: {
    textShadowColor: "rgba(6,6,8,0.6)",
    textShadowRadius: 4,
    textShadowOffset: { width: 0, height: 1 },
  },
});

const styles = StyleSheet.create({
  bar: {
    position: "absolute",
    left: tokens.spacing.lg,
    right: tokens.spacing.lg,
    zIndex: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: tokens.spacing.sm,
    pointerEvents: "box-none",
  },
  actions: {
    flex: 1,
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: tokens.spacing.lg,
  },
  icon: {
    ...iconShadow,
  },
});
