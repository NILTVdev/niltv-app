import { ActivityIndicator, StyleSheet, Text, View } from "react-native";

import { GoldButton } from "@/components/GoldButton";
import { tokens } from "@/theme/tokens";
import { useTheme } from "@/theme/useTheme";

/**
 * Generic centered spinner — the fallback for shapes without a drawn skeleton
 * (see Skeleton.tsx). Transparent: painting its own panel left a visible seam
 * on the #060608 screens.
 */
export function LoadingState() {
  const t = useTheme();
  return (
    <View style={styles.wrap}>
      <ActivityIndicator size="large" color={t.accent} />
    </View>
  );
}

/** Standard unreachable-API state; render inside a pull-to-refresh scroll view. */
export function ErrorState({ onRetry }: { onRetry: () => void }) {
  const t = useTheme();
  return (
    <View style={styles.wrap}>
      <Text style={[styles.title, { color: t.text }]}>Can&apos;t reach NILTV</Text>
      <Text style={[styles.copy, { color: t.subtext }]}>Pull to retry, or tap below.</Text>
      <GoldButton label="Retry" onPress={onRetry} style={styles.retry} />
    </View>
  );
}

export function EmptyState({ message }: { message: string }) {
  const t = useTheme();
  return (
    <View style={styles.wrap}>
      <Text style={[styles.copy, { color: t.subtext }]}>{message}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flexGrow: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: tokens.spacing.sm,
    padding: tokens.spacing.xl,
    minHeight: 220,
    borderRadius: tokens.radius,
  },
  title: {
    fontFamily: tokens.font.extrabold,
    fontSize: 18,
  },
  copy: {
    fontFamily: tokens.font.regular,
    fontSize: 14,
    textAlign: "center",
  },
  retry: {
    alignSelf: "center",
    minWidth: 160,
    marginTop: tokens.spacing.sm,
  },
});
