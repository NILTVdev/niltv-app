/**
 * The site's network marquee (webapp/channels/index.html .chmq; motion,
 * not video): two rails of real 9:16 posters drifting
 * sideways under a 2deg tilt, row A one way at 192s a loop, row B the other
 * at 240s, so slow the eye reads it as a wall, not a ticker. Each row renders
 * its ids three times (more on a wide window) and slides exactly one group
 * width before wrapping, so the loop never shows a seam. Decorative only:
 * no touches, hidden from screen readers, still under reduce motion.
 *
 * Two sizes: "hero" is the Channels tab (tiles 118/100, the
 * site's phone heights); "compact" is the auth screen band (84/72).
 */
import { Image } from "expo-image";
import { LinearGradient } from "expo-linear-gradient";
import { useEffect } from "react";
import { StyleSheet, View, useWindowDimensions } from "react-native";
import Animated, {
  Easing,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";

import { config } from "@/config";
import { MARQUEE_ROW_A, MARQUEE_ROW_B, marqueePosterUrl } from "@/lib/marquee";
import { useTheme } from "@/theme/useTheme";

/** .chmq-card aspect-ratio: 300/532. */
const TILE_ASPECT = 300 / 532;
/** .chmq-group gap. */
const GAP = 14;
/** .chmq-mq--b margin-top. */
const ROW_GAP = 18;
const TILT = "-2deg";
/** The site's animation-delay (-22s / -58s) as a fraction of each loop. */
const PHASE_A = 22 / 192;
const PHASE_B = 58 / 240;

const VARIANTS = {
  hero: { a: 118, b: 100, block: 264, bottomFade: 70 },
  compact: { a: 84, b: 72, block: 190, bottomFade: 50 },
} as const;

export type NetworkMarqueeVariant = keyof typeof VARIANTS;

/** "#rrggbb" at an alpha, so the fades end in the ground colour, not black. */
function withAlpha(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

function Row({
  ids,
  height,
  direction,
  duration,
  phase,
  viewportWidth,
  opacity,
}: {
  ids: readonly string[];
  height: number;
  direction: "left" | "right";
  /** ms per loop (one group width). */
  duration: number;
  /** start offset, 0..1 of a loop, so the rows never line up. */
  phase: number;
  viewportWidth: number;
  opacity: number;
}) {
  const t = useTheme();
  const tileWidth = Math.round(height * TILE_ASPECT);
  const groupWidth = ids.length * (tileWidth + GAP);
  // Enough copies that a full group can slide out and the row still covers
  // the viewport; three is the site's count and the floor here.
  const copies = Math.max(3, Math.ceil(viewportWidth / groupWidth) + 1);

  const progress = useSharedValue(0);
  useEffect(() => {
    progress.value = 0;
    progress.value = withRepeat(
      withTiming(1, { duration, easing: Easing.linear, reduceMotion: ReduceMotion.System }),
      -1,
      false,
    );
  }, [progress, duration]);
  const track = useAnimatedStyle(() => {
    // The track is periodic in groupWidth, so the phase is a plain offset
    // and the wrap from 1 back to 0 lands on the same pixels.
    const pos = (progress.value + phase) % 1;
    const x = direction === "left" ? -pos * groupWidth : -(1 - pos) * groupWidth;
    return { transform: [{ translateX: x }] };
  });

  return (
    <View style={[styles.row, { height, opacity }]}>
      <Animated.View style={[styles.track, track]}>
        {Array.from({ length: copies }, (_, copy) =>
          ids.map((id) => (
            <View
              key={`${copy}-${id}`}
              style={[styles.tile, { width: tileWidth, height, backgroundColor: t.surface }]}
            >
              <Image
                source={{ uri: marqueePosterUrl(config.apiBase, id) }}
                style={StyleSheet.absoluteFill}
                contentFit="cover"
                cachePolicy="memory-disk"
                recyclingKey={id}
                transition={0}
              />
            </View>
          )),
        )}
      </Animated.View>
    </View>
  );
}

export function NetworkMarquee({ variant = "hero" }: { variant?: NetworkMarqueeVariant }) {
  const t = useTheme();
  const { width } = useWindowDimensions();
  const size = VARIANTS[variant];
  const clear = withAlpha(t.bg, 0);
  // .chmq on phones: width 114%, pulled 7% left, so the tilted corners never
  // show inside the band.
  const blockWidth = Math.ceil(width * 1.14);

  return (
    <View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[styles.band, { height: size.block }]}
    >
      <View
        style={[
          styles.block,
          { width: blockWidth, marginLeft: -Math.round(width * 0.07), transform: [{ rotate: TILT }] },
        ]}
      >
        <Row
          ids={MARQUEE_ROW_A}
          height={size.a}
          direction="left" // both rows travel left, as the site's chmq tracks do (0 -> -33%)
          duration={192_000}
          phase={PHASE_A}
          viewportWidth={blockWidth}
          opacity={1}
        />
        <Row
          ids={MARQUEE_ROW_B}
          height={size.b}
          direction="left"
          duration={240_000}
          phase={PHASE_B}
          viewportWidth={blockWidth}
          opacity={0.88}
        />
        {/* Edge fades (.chmq-mq mask-image: clear 10% in from each side). */}
        <LinearGradient
          colors={[t.bg, clear]}
          start={{ x: 0, y: 0.5 }}
          end={{ x: 1, y: 0.5 }}
          style={[styles.edge, styles.edgeLeft]}
        />
        <LinearGradient
          colors={[clear, t.bg]}
          start={{ x: 0, y: 0.5 }}
          end={{ x: 1, y: 0.5 }}
          style={[styles.edge, styles.edgeRight]}
        />
      </View>
      {/* Bottom fade into the page ground (.chmq-scrim-b). */}
      <LinearGradient
        colors={[clear, t.bg]}
        style={[styles.bottomFade, { height: size.bottomFade }]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  band: {
    width: "100%",
    overflow: "hidden",
    justifyContent: "center",
  },
  block: {
    gap: ROW_GAP,
  },
  row: {
    width: "100%",
    overflow: "hidden",
  },
  track: {
    flexDirection: "row",
    gap: GAP,
  },
  // .chmq-card: 8px radius, hairline light ring, surface ground while loading.
  tile: {
    borderRadius: 8,
    overflow: "hidden",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255,255,255,0.05)",
  },
  edge: {
    position: "absolute",
    top: 0,
    bottom: 0,
    width: "12%",
  },
  edgeLeft: {
    left: 0,
  },
  edgeRight: {
    right: 0,
  },
  bottomFade: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
  },
});
