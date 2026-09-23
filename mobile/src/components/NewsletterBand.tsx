/**
 * Newsletter entry band — the compact "The Playbook" CTA reused by three of
 * the five tagged entry points (home band, post-vote, recap; spec §5.6).
 * Navigates to the modal newsletter screen carrying its source tag.
 */
import type { NewsletterSource } from "@niltv/types";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { track } from "@/telemetry";
import { tokens } from "@/theme/tokens";
import { useTheme } from "@/theme/useTheme";

export function NewsletterBand({
  source,
  title = "Get The Playbook",
  copy = "Athlete spotlights, voting windows & results. Free in your inbox.",
}: {
  source: NewsletterSource;
  title?: string;
  copy?: string;
}) {
  const t = useTheme();
  const router = useRouter();
  return (
    <Pressable
      onPress={() => {
        track("newsletter_band_tap", { source });
        router.push({ pathname: "/newsletter", params: { source } });
      }}
      accessibilityRole="button"
      accessibilityLabel={`${title}, newsletter signup`}
      style={({ pressed }) => [
        styles.band,
        { backgroundColor: t.surface, borderColor: t.line, opacity: pressed ? 0.8 : 1 },
      ]}
    >
      <Ionicons name="mail-outline" size={22} color={tokens.color.gold} />
      <View style={styles.text}>
        <Text style={[styles.title, { color: t.text }]}>{title}</Text>
        <Text numberOfLines={2} style={[styles.copy, { color: t.subtext }]}>
          {copy}
        </Text>
      </View>
      <Ionicons name="chevron-forward" size={18} color={t.subtext} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  band: {
    flexDirection: "row",
    alignItems: "center",
    gap: tokens.spacing.md,
    borderWidth: 1,
    borderRadius: tokens.radius,
    padding: tokens.spacing.lg,
    marginHorizontal: tokens.spacing.lg,
    marginTop: tokens.spacing.lg,
  },
  text: {
    flex: 1,
  },
  title: {
    fontFamily: tokens.font.extrabold,
    fontSize: 15,
  },
  copy: {
    fontFamily: tokens.font.regular,
    fontSize: 12,
    lineHeight: 17,
    marginTop: 2,
  },
});
