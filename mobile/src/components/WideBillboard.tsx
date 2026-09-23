/**
 * A poster billboard for one horizontal FeaturedSlide (the Competitions
 * tab's audition compilation): a full-width 16:9 band on black with the
 * poster cover-fit and a gold play circle, then the site's hero copy stack
 * under it (gold kicker, title, dek). No autoplaying loop here, that stays
 * the Home hero's job; this is a still with a play glyph. A tap anywhere
 * opens the slide's watch target exactly as HeroCarousel does: hz episodes
 * go to the theater with the full cut, API content opens the vertical player.
 */
import { Ionicons } from "@expo/vector-icons";
import { Image } from "expo-image";
import { useRouter } from "expo-router";
import { StyleSheet, Text, View, useWindowDimensions } from "react-native";

import { PressableScale } from "@/components/PressableScale";
import type { FeaturedSlide } from "@/lib/featured";
import { track } from "@/telemetry";
import { tokens } from "@/theme/tokens";

export function WideBillboard({ slide }: { slide: FeaturedSlide }) {
  const router = useRouter();
  const { width } = useWindowDimensions();
  const bandH = Math.round((width * 9) / 16);

  const watch = () => {
    if (slide.watch.kind === "content") {
      track("card_tap", { contentId: slide.watch.contentId, from: "competitions_billboard" });
      router.push({
        pathname: "/video/[contentId]",
        params: { contentId: slide.watch.contentId, channelId: slide.watch.channelId },
      });
      return;
    }
    track("card_tap", { featured: slide.key, from: "competitions_billboard" });
    router.push({
      pathname: "/theater",
      params: {
        src: slide.watch.src,
        poster: slide.watch.poster,
        title: slide.watch.title,
        kicker: slide.watch.kicker,
      },
    });
  };

  return (
    <PressableScale
      scaleTo={1}
      onPress={watch}
      accessibilityRole="button"
      accessibilityLabel={`Watch ${slide.title}`}
      style={styles.wrap}
    >
      <View style={[styles.band, { width, height: bandH }]}>
        <Image
          source={{ uri: slide.posterUrl }}
          contentFit="cover"
          transition={tokens.motion.base}
          cachePolicy="memory-disk"
          style={StyleSheet.absoluteFill}
        />
        <View style={styles.playWrap} pointerEvents="none">
          <View style={styles.playCircle}>
            <Ionicons name="play" size={24} color={tokens.color.ink} style={styles.playIcon} />
          </View>
        </View>
      </View>
      <View style={styles.copy}>
        <Text style={styles.kicker}>{slide.kicker.toUpperCase()}</Text>
        <Text style={styles.title} numberOfLines={2}>
          {slide.title.toUpperCase()}
        </Text>
        {/* One line, shrinking before it wraps: a dek that breaks onto a
            second line leaves a lone word hanging under the title. Copy
            for this slot stays short (lib/featured.ts). */}
        <Text style={styles.dek} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8}>
          {slide.dek}
        </Text>
      </View>
    </PressableScale>
  );
}

const styles = StyleSheet.create({
  wrap: {
    marginTop: tokens.spacing.xl,
  },
  // The letterbox behind the poster, the site's .hreel background:#000.
  band: {
    backgroundColor: "#000000",
    overflow: "hidden",
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
  // Card's play glyph at billboard scale: 56dp gold disc, ink chevron.
  playCircle: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: tokens.color.gold,
    alignItems: "center",
    justifyContent: "center",
  },
  playIcon: {
    marginLeft: 3,
  },
  copy: {
    paddingHorizontal: tokens.spacing.lg,
    paddingTop: tokens.spacing.md,
  },
  // The site's .hero-kicker: gold Barlow 700, 15px, .24em tracking (3.6).
  kicker: {
    color: tokens.color.gold,
    fontFamily: tokens.font.displayBold,
    fontSize: 15,
    letterSpacing: 3.6,
    marginBottom: tokens.spacing.xs,
  },
  title: {
    color: "#ffffff",
    fontFamily: tokens.font.display,
    fontSize: tokens.text.title,
    lineHeight: tokens.text.title + 4,
    letterSpacing: 0.5,
  },
  // The site's .hero-dek: Inter, dim.
  dek: {
    color: tokens.color.muted,
    fontFamily: tokens.font.regular,
    fontSize: 15,
    lineHeight: 20,
    marginTop: 4,
  },
});
