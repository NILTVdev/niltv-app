/**
 * The Privacy Policy link every data-collection form carries (App Store
 * 5.1.1(i) and the team's form rules). Same shape as EventInfoSections'
 * LegalLink: quiet subtext line, opens niltv.com in the browser.
 */
import { Linking, StyleSheet, Text } from "react-native";

import { PressableScale } from "@/components/PressableScale";
import { config } from "@/config";
import { tokens } from "@/theme/tokens";
import { useTheme } from "@/theme/useTheme";

export function PrivacyLink() {
  const t = useTheme();
  return (
    <PressableScale
      onPress={() => void Linking.openURL(config.privacyUrl).catch(() => undefined)}
      accessibilityRole="link"
      accessibilityLabel="Read the NILTV Privacy Policy"
      hitSlop={8}
      style={styles.link}
    >
      <Text style={[styles.text, { color: t.subtext }]}>Privacy Policy</Text>
    </PressableScale>
  );
}

const styles = StyleSheet.create({
  link: {
    alignSelf: "center",
    paddingVertical: tokens.spacing.sm,
  },
  text: {
    fontFamily: tokens.font.semibold,
    fontSize: 13,
    textDecorationLine: "underline",
  },
});
