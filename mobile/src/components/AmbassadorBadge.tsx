import { Ionicons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import { StyleSheet, Text, type ViewStyle } from "react-native";

import { tokens } from "@/theme/tokens";

export interface AmbassadorBadgeProps {
  /** "mini" rides inline next to a name (demo .miniamb); default is the profile badge (.ambadge) */
  size?: "mini" | "regular";
  label?: string;
  style?: ViewStyle;
}

/** ★Ambassador badge — gold gradient chip per the demo (vision.html .ambadge/.miniamb). */
export function AmbassadorBadge({ size = "regular", label = "Ambassador", style }: AmbassadorBadgeProps) {
  const mini = size === "mini";
  return (
    <LinearGradient
      colors={[tokens.color.gold, tokens.color.goldDeep]}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 1 }}
      style={[styles.badge, mini ? styles.badgeMini : styles.badgeRegular, style]}
    >
      <Ionicons name="star" size={mini ? 9 : 12} color="#1a1a1f" />
      <Text style={[styles.label, { fontSize: mini ? 9 : 11 }]}>{label}</Text>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  badge: {
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
  },
  badgeMini: {
    gap: 3,
    paddingVertical: 2,
    paddingHorizontal: 6,
    borderRadius: 5,
  },
  badgeRegular: {
    gap: 4,
    paddingVertical: 4,
    paddingHorizontal: 9,
    borderRadius: 7,
  },
  label: {
    color: "#1a1a1f",
    fontFamily: tokens.font.bold,
    letterSpacing: 0.3,
  },
});
