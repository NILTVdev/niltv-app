import { ActivityIndicator, StyleSheet, Text, type ViewStyle } from "react-native";

import { PressableScale } from "@/components/PressableScale";
import { tokens } from "@/theme/tokens";
import { useTheme } from "@/theme/useTheme";

export interface GoldButtonProps {
  label: string;
  onPress: () => void;
  /** solid gold CTA (default) or a quiet outline (e.g. "Following") */
  variant?: "solid" | "outline";
  disabled?: boolean;
  /** shows a spinner and blocks presses */
  busy?: boolean;
  style?: ViewStyle;
}

/** The demo's gold CTA button (vision.html .btn), shared by sheets and screens. */
export function GoldButton({
  label,
  onPress,
  variant = "solid",
  disabled = false,
  busy = false,
  style,
}: GoldButtonProps) {
  const t = useTheme();
  const solid = variant === "solid";
  return (
    <PressableScale
      onPress={onPress}
      disabled={disabled || busy}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={[
        styles.base,
        solid
          ? { backgroundColor: tokens.color.gold }
          : { borderWidth: 1.5, borderColor: t.accent, backgroundColor: "transparent" },
        (disabled || busy) && styles.disabled,
        style,
      ]}
    >
      {busy ? (
        <ActivityIndicator size="small" color={solid ? "#1a1a1f" : t.accent} />
      ) : (
        <Text style={[styles.label, { color: solid ? "#1a1a1f" : t.accent }]}>{label}</Text>
      )}
    </PressableScale>
  );
}

const styles = StyleSheet.create({
  base: {
    alignSelf: "stretch",
    borderRadius: 9,
    paddingVertical: 14,
    paddingHorizontal: 18,
    alignItems: "center",
    justifyContent: "center",
    minHeight: 48,
  },
  disabled: {
    opacity: 0.55,
  },
  label: {
    fontFamily: tokens.font.bold,
    fontSize: 15,
  },
});
