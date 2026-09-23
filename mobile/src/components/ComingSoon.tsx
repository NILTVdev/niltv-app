import { Ionicons } from "@expo/vector-icons";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { goBack } from "@/lib/navigation";
import { tokens } from "@/theme/tokens";
import { useTheme } from "@/theme/useTheme";

/**
 * Themed placeholder for routes that ship dark behind a config flag
 * (design §3.1: ambassadors/profiles are "built but behind
 * flags.ambassadorDirectory"). The route exists; the content waits.
 */
export function ComingSoon({ title }: { title: string }) {
  const t = useTheme();
  return (
    <SafeAreaView edges={["top"]} style={[styles.screen, { backgroundColor: t.bg }]}>
      <Pressable
        onPress={() => goBack()}
        accessibilityRole="button"
        accessibilityLabel="Back"
        style={styles.back}
      >
        <Ionicons name="chevron-back" size={22} color={t.text} />
        <Text style={[styles.backLabel, { color: t.text }]}>Back</Text>
      </Pressable>
      <View style={styles.body}>
        <Ionicons name="star" size={44} color={tokens.color.gold} />
        <Text style={[styles.title, { color: t.text }]}>{title}</Text>
        <Text style={[styles.copy, { color: t.subtext }]}>
          Coming soon — we&apos;re still rolling out the red carpet.
        </Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },
  back: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    paddingHorizontal: tokens.spacing.lg,
    paddingVertical: tokens.spacing.md,
    alignSelf: "flex-start",
  },
  backLabel: {
    fontFamily: tokens.font.semibold,
    fontSize: 15,
  },
  body: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: tokens.spacing.sm,
    padding: tokens.spacing.xl,
  },
  title: {
    fontFamily: tokens.font.extrabold,
    fontSize: 22,
  },
  copy: {
    fontFamily: tokens.font.regular,
    fontSize: 14,
    textAlign: "center",
  },
});
