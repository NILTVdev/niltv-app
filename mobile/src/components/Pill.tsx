import { StyleSheet, Text, View, type ViewStyle } from "react-native";

import { tokens } from "@/theme/tokens";

export interface PillProps {
  label: string;
  /** show the red live dot before the label (demo .pill .dot) */
  live?: boolean;
  style?: ViewStyle;
}

/** Gold badge — solid gold, dark text, per the demo (vision.html .pill). */
export function Pill({ label, live = false, style }: PillProps) {
  return (
    <View style={[styles.pill, style]}>
      {live ? <View style={styles.dot} /> : null}
      <Text style={styles.label}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: tokens.color.gold,
    paddingVertical: 5,
    paddingHorizontal: 10,
    borderRadius: 8,
  },
  dot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: "#c0392b",
  },
  label: {
    color: "#1a1a1f",
    fontFamily: tokens.font.bold,
    fontSize: 11,
    letterSpacing: 0.4,
    textTransform: "uppercase",
  },
});
