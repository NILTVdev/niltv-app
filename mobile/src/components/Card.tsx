import { Ionicons } from "@expo/vector-icons";
import { Image } from "expo-image";
import { LinearGradient } from "expo-linear-gradient";
import { useState } from "react";
import { StyleSheet, Text, View } from "react-native";

import { PressableScale } from "@/components/PressableScale";
import { tokens } from "@/theme/tokens";

/** Gold-tone placeholder gradients, ported from the demo (vision.html grads[]). */
const GRADS: readonly [string, string][] = [
  ["#C2A030", "#8a6e1b"],
  ["#1a1a1f", "#8a6e1b"],
  ["#D4B84A", "#a07d1d"],
  ["#8a6e1b", "#3a2f12"],
  ["#E0C868", "#C2A030"],
  ["#6b5413", "#C2A030"],
  ["#2a2418", "#9a7a1e"],
  ["#b8962c", "#5c4910"],
  ["#9a7a1e", "#1a1a1f"],
  ["#C2A030", "#2a2418"],
];

/** Deterministic fallback gradient for an id/title — loading/error backdrop. */
export function thumbGradient(seed: string): readonly [string, string] {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return GRADS[h % GRADS.length] ?? GRADS[0]!;
}

export interface CardProps {
  title: string;
  /** second line under the title, e.g. "TrueBlue TV · Camila Garza" */
  meta?: string;
  /** real artwork (poster/avatar); the gradient stays underneath as the loading/error backdrop */
  imageUrl?: string;
  /** portrait video 9:16 (rails) or 3:4 (people) */
  aspect?: "9:16" | "3:4";
  width?: number;
  /** placeholder gradient override; defaults to a deterministic pick by title */
  colors?: readonly [string, string];
  /** center play glyph for video content */
  showPlay?: boolean;
  onPress?: () => void;
}

/**
 * Portrait thumbnail card with bottom meta overlay (demo .card / .fcard).
 * Renders imageUrl artwork when present; the deterministic gradient is the
 * backdrop while loading and the fallback when the image errors.
 */
export function Card({
  title,
  meta,
  imageUrl,
  aspect = "9:16",
  width = 180,
  colors,
  showPlay = true,
  onPress,
}: CardProps) {
  const height = aspect === "9:16" ? (width * 16) / 9 : (width * 4) / 3;
  const grad = colors ?? thumbGradient(title);
  const [imageFailed, setImageFailed] = useState(false);
  // Landscape artwork (16:9 clips, horizontal stills) cover-crops into the
  // portrait frame (no horizontal posters in the app; the centre
  // third of a wide frame is its vertical poster, faces sit there). One
  // standard for every clip, ingested or backfilled: every card in the app
  // renders through here.
  return (
    <PressableScale
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={title}
      style={[styles.card, { width, height }]}
    >
      <LinearGradient
        colors={grad}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
      {imageUrl && !imageFailed ? (
        <Image
          source={{ uri: imageUrl }}
          style={StyleSheet.absoluteFill}
          contentFit="cover"
          // Crossfade over the gradient instead of popping in; disk+memory
          // cache stops rails re-downloading art on every visit.
          transition={tokens.motion.base}
          cachePolicy="memory-disk"
          onError={() => setImageFailed(true)}
        />
      ) : null}
      {showPlay ? (
        <View style={styles.playWrap}>
          <View style={styles.playCircle}>
            <Ionicons name="play" size={18} color="#ffffff" style={styles.playIcon} />
          </View>
        </View>
      ) : null}
      <LinearGradient
        colors={["transparent", "rgba(0,0,0,0.78)"]}
        locations={[0.45, 1]}
        style={StyleSheet.absoluteFill}
      />
      <View style={styles.meta}>
        <Text numberOfLines={2} style={styles.title}>
          {title}
        </Text>
        {meta ? (
          <Text numberOfLines={3} style={styles.sub}>
            {meta}
          </Text>
        ) : null}
      </View>
    </PressableScale>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: tokens.radius - 2,
    overflow: "hidden",
    backgroundColor: tokens.color.ink,
  },
  playWrap: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  playCircle: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: "rgba(22,22,26,0.45)",
    alignItems: "center",
    justifyContent: "center",
  },
  playIcon: {
    marginLeft: 2,
  },
  meta: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    padding: tokens.spacing.md,
  },
  title: {
    color: "#ffffff",
    fontFamily: tokens.font.bold,
    fontSize: 14,
    lineHeight: 17,
  },
  sub: {
    color: "rgba(255,255,255,0.85)",
    fontFamily: tokens.font.regular,
    fontSize: 11,
    marginTop: 3,
  },
});
