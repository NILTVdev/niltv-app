import { useEffect } from "react";
import { StyleSheet, View, type DimensionValue, type StyleProp, type ViewStyle } from "react-native";
import Animated, {
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";

import { tokens } from "@/theme/tokens";
import { useTheme } from "@/theme/useTheme";

/**
 * Loading placeholders shaped like the layout they precede, so screens resolve
 * instead of appearing (the spinner-only LoadingState stays as the generic
 * fallback for shapes we haven't drawn). One pulse per composed skeleton;
 * respects the OS reduce-motion setting.
 */

function usePulse() {
  const pulse = useSharedValue(0.55);
  useEffect(() => {
    pulse.value = withRepeat(
      withTiming(1, { duration: 800, reduceMotion: ReduceMotion.System }),
      -1,
      true,
    );
  }, [pulse]);
  return useAnimatedStyle(() => ({ opacity: pulse.value }));
}

function Block({
  width,
  height,
  radius = tokens.radius - 2,
  style,
}: {
  width: DimensionValue;
  height: number;
  radius?: number;
  style?: StyleProp<ViewStyle>;
}) {
  const t = useTheme();
  return (
    <View
      style={[{ width, height, borderRadius: radius, backgroundColor: t.surface }, style]}
    />
  );
}

/** Hero banner placeholder (Home + hub lead slots). */
export function BannerSkeleton() {
  const t = useTheme();
  const pulse = usePulse();
  return (
    <Animated.View style={pulse} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <View style={[styles.banner, { backgroundColor: t.surface }]}>
        <Block width={110} height={20} radius={999} style={{ backgroundColor: t.inset }} />
        <Block width="72%" height={22} style={{ backgroundColor: t.inset, marginTop: tokens.spacing.md }} />
        <Block width="52%" height={13} style={{ backgroundColor: t.inset, marginTop: tokens.spacing.sm }} />
        <Block width="100%" height={48} radius={9} style={{ backgroundColor: t.inset, marginTop: tokens.spacing.lg }} />
      </View>
    </Animated.View>
  );
}

/** One rail: header bar + a strip of portrait cards (Home). */
export function RailSkeleton({ cardWidth = 180, aspect = "9:16" as "9:16" | "3:4" }) {
  const pulse = usePulse();
  const height = aspect === "9:16" ? (cardWidth * 16) / 9 : (cardWidth * 4) / 3;
  return (
    <Animated.View style={pulse} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <View style={styles.railHeader}>
        <Block width={140} height={17} />
      </View>
      <View style={styles.railRow}>
        {[0, 1, 2].map((i) => (
          <Block key={i} width={cardWidth} height={height} />
        ))}
      </View>
    </Animated.View>
  );
}

/** Grid of tiles (Channels, channel clip grids). */
export function GridSkeleton({
  tiles = 6,
  tileAspect = 9 / 16,
  columns = 2,
}: {
  tiles?: number;
  tileAspect?: number;
  columns?: number;
}) {
  const pulse = usePulse();
  return (
    <Animated.View
      style={[styles.grid, pulse]}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {Array.from({ length: tiles }, (_, i) => (
        <View key={i} style={{ width: `${100 / columns - 2}%` as DimensionValue }}>
          <SkeletonTile aspect={tileAspect} />
        </View>
      ))}
    </Animated.View>
  );
}

function SkeletonTile({ aspect }: { aspect: number }) {
  const t = useTheme();
  return (
    <View
      style={{
        width: "100%",
        aspectRatio: aspect,
        borderRadius: tokens.radius - 2,
        backgroundColor: t.surface,
      }}
    />
  );
}

/** List rows: thumb + two text lines (hub events, following, directories). */
export function RowsSkeleton({ rows = 3 }: { rows?: number }) {
  const t = useTheme();
  const pulse = usePulse();
  return (
    <Animated.View style={pulse} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {Array.from({ length: rows }, (_, i) => (
        <View key={i} style={[styles.row, { borderColor: t.line, backgroundColor: t.surface }]}>
          <Block width={58} height={58} radius={10} style={{ backgroundColor: t.inset }} />
          <View style={styles.rowBody}>
            <Block width="62%" height={15} style={{ backgroundColor: t.inset }} />
            <Block width="40%" height={12} style={{ backgroundColor: t.inset, marginTop: 6 }} />
          </View>
        </View>
      ))}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  banner: {
    borderRadius: tokens.radius,
    padding: 20,
  },
  railHeader: {
    paddingHorizontal: tokens.spacing.lg,
    marginTop: tokens.spacing.xl,
    marginBottom: tokens.spacing.md,
  },
  railRow: {
    flexDirection: "row",
    gap: tokens.spacing.md,
    paddingHorizontal: tokens.spacing.lg,
    overflow: "hidden",
  },
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "space-between",
    rowGap: tokens.spacing.md,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: tokens.spacing.md,
    borderWidth: 1,
    borderRadius: tokens.radius,
    padding: 10,
    marginBottom: 10,
  },
  rowBody: {
    flex: 1,
  },
});
