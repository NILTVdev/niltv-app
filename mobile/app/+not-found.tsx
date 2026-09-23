import { Link } from "expo-router";
import { StyleSheet, Text, View } from "react-native";

import { tokens } from "@/theme/tokens";
import { useTheme } from "@/theme/useTheme";

export default function NotFoundScreen() {
  const t = useTheme();

  return (
    <View
      style={[
        styles.screen,
        { backgroundColor: t.dark ? tokens.color.ink : "#ffffff" },
      ]}
    >
      <Text style={[styles.title, { color: t.text }]}>Not Found</Text>
      <Text style={[styles.copy, { color: t.subtext }]}>
        This page doesn&apos;t exist yet.
      </Text>
      <Link href="/" style={styles.cta}>
        <Text style={styles.ctaLabel}>Back to Home</Text>
      </Link>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: tokens.spacing.md,
    padding: tokens.spacing.xl,
  },
  title: {
    fontFamily: tokens.font.extrabold,
    fontSize: 22,
  },
  copy: {
    fontFamily: tokens.font.regular,
    fontSize: 14,
    lineHeight: 20,
    textAlign: "center",
  },
  cta: {
    backgroundColor: tokens.color.gold,
    borderRadius: 9,
    paddingVertical: 14,
    paddingHorizontal: 18,
    marginTop: tokens.spacing.sm,
    overflow: "hidden",
  },
  ctaLabel: {
    color: "#1a1a1f",
    fontFamily: tokens.font.bold,
    fontSize: 15,
  },
});
