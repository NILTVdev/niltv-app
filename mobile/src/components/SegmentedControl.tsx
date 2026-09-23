import { Platform, Pressable, ScrollView, StyleSheet, Text, View, type ViewStyle } from "react-native";

import { tokens } from "@/theme/tokens";
import { useTheme } from "@/theme/useTheme";

export interface SegmentedControlProps {
  options: string[];
  value: string;
  onChange: (value: string) => void;
  /**
   * Finger-scroll the track instead of flexing segments to equal widths — for
   * option counts that no longer fit one screen (e.g. the Watch channel list).
   */
  scrollable?: boolean;
}

/** Soft track with a white active segment (demo .seg). */
export function SegmentedControl({ options, value, onChange, scrollable = false }: SegmentedControlProps) {
  const t = useTheme();
  const segments = options.map((option) => {
    const active = option === value;
    return (
      <Pressable
        key={option}
        onPress={() => onChange(option)}
        accessibilityRole="button"
        accessibilityState={{ selected: active }}
        style={[
          scrollable ? styles.segmentFixed : styles.segment,
          active && [styles.segmentActive, { backgroundColor: t.dark ? "#3d3d45" : "#ffffff" }],
        ]}
      >
        <Text
          numberOfLines={1}
          style={[styles.label, { color: active ? t.text : t.subtext }]}
        >
          {option}
        </Text>
      </Pressable>
    );
  });

  if (scrollable) {
    return (
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <View style={[styles.track, { backgroundColor: t.inset }]}>{segments}</View>
      </ScrollView>
    );
  }
  return <View style={[styles.track, { backgroundColor: t.inset }]}>{segments}</View>;
}

// Same 0/2px offset, 8px blur, 8% black either way; RNW 0.21 deprecates the
// shadow* long-hand in favor of the CSS boxShadow short-hand (RN types both).
const activeShadow: ViewStyle = Platform.select<ViewStyle>({
  web: { boxShadow: "0 2px 8px rgba(0,0,0,0.08)" },
  default: {
    shadowColor: "#000000",
    shadowOpacity: 0.08,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
});

const styles = StyleSheet.create({
  track: {
    flexDirection: "row",
    borderRadius: 10,
    padding: 4,
    gap: 4,
  },
  segment: {
    flex: 1,
    paddingVertical: 9,
    borderRadius: 7,
    alignItems: "center",
  },
  segmentFixed: {
    paddingVertical: 9,
    paddingHorizontal: 14,
    borderRadius: 7,
    alignItems: "center",
  },
  segmentActive: {
    ...activeShadow,
  },
  label: {
    fontFamily: tokens.font.bold,
    fontSize: 13,
  },
});
