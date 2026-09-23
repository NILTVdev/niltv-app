import { Ionicons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import { Pressable, StyleSheet, Text } from "react-native";

import { Pill } from "@/components/Pill";
import { PressableScale } from "@/components/PressableScale";
import { tokens } from "@/theme/tokens";

export interface BannerProps {
  title: string;
  subtitle?: string;
  /** gold pill above the title, e.g. "LIVE · VOTING OPEN" */
  badge?: string;
  /** red blinking-dot treatment on the badge */
  live?: boolean;
  /** gold CTA button label, e.g. "Vote Now" */
  cta?: string;
  onPress?: () => void;
  onCtaPress?: () => void;
}

/**
 * Hero banner — dark gradient card with the big translucent gold star,
 * per the demo (vision.html .banner + .bgstar).
 */
export function Banner({ title, subtitle, badge, live = false, cta, onPress, onCtaPress }: BannerProps) {
  // With a CTA inside, the outer surface must not take the button role:
  // react-native-web renders role="button" as a real <button>, nested buttons
  // are invalid HTML, and expo-router's web prerender then fails to hydrate.
  // The CTA carries the accessible action; the card press is a pointer
  // convenience that duplicates it.
  return (
    <Pressable onPress={onPress} accessibilityRole={onPress && !cta ? "button" : undefined}>
      <LinearGradient
        colors={["#1a1a1f", "#2a2418"]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={styles.banner}
      >
        <Ionicons name="star" size={130} color={tokens.color.gold} style={styles.bgstar} />
        {badge ? <Pill label={badge} live={live} /> : null}
        <Text style={styles.title}>{title}</Text>
        {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
        {cta ? (
          <PressableScale
            onPress={(event) => {
              // Web: a CTA click also bubbles to the card's press — without
              // this, "Submit Your Entry" would open the form AND navigate.
              event?.stopPropagation?.();
              (onCtaPress ?? onPress)?.();
            }}
            accessibilityRole="button"
            style={styles.cta}
          >
            <Text style={styles.ctaLabel}>{cta}</Text>
          </PressableScale>
        ) : null}
      </LinearGradient>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  banner: {
    borderRadius: tokens.radius,
    padding: 20,
    overflow: "hidden",
  },
  bgstar: {
    position: "absolute",
    right: -14,
    top: -20,
    opacity: 0.14,
  },
  title: {
    color: "#ffffff",
    fontFamily: tokens.font.extrabold,
    fontSize: 22,
    letterSpacing: 0.2,
    marginTop: tokens.spacing.md,
    marginBottom: tokens.spacing.xs,
  },
  subtitle: {
    color: "#d9d4c4",
    fontFamily: tokens.font.regular,
    fontSize: 13,
    marginBottom: tokens.spacing.lg,
  },
  cta: {
    backgroundColor: tokens.color.gold,
    borderRadius: 9,
    paddingVertical: 14,
    paddingHorizontal: 18,
    alignItems: "center",
  },
  ctaLabel: {
    color: "#1a1a1f",
    fontFamily: tokens.font.bold,
    fontSize: 15,
  },
});
