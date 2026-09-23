import { Image } from "expo-image";
import { LinearGradient } from "expo-linear-gradient";
import { StyleSheet, Text } from "react-native";

import { thumbGradient } from "@/components/Card";
import { tokens } from "@/theme/tokens";

export interface AvatarProps {
  name: string;
  /** remote image when available; falls back to an initials gradient */
  url?: string;
  /** deterministic gradient seed (defaults to name) so an id keeps its color */
  seed?: string;
  size?: number;
}

/** Circle avatar — remote photo when we have one, demo-style initials gradient otherwise. */
export function Avatar({ name, url, seed, size = 44 }: AvatarProps) {
  const round = { width: size, height: size, borderRadius: size / 2 };
  if (url) {
    return (
      <Image
        source={{ uri: url }}
        style={round}
        contentFit="cover"
        transition={tokens.motion.base}
        cachePolicy="memory-disk"
      />
    );
  }
  const initials = name
    .split(/\s+/)
    .map((part) => part.charAt(0).toUpperCase())
    .slice(0, 2)
    .join("");
  return (
    <LinearGradient
      colors={thumbGradient(seed ?? name)}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 1 }}
      style={[styles.fallback, round]}
    >
      <Text style={[styles.initials, { fontSize: Math.round(size * 0.36) }]}>{initials}</Text>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  fallback: {
    alignItems: "center",
    justifyContent: "center",
  },
  initials: {
    color: "#ffffff",
    fontFamily: tokens.font.bold,
  },
});
