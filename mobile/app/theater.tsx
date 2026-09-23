/**
 * Theater: the site's Watch modal for the horizontal featured episodes
 * (mirrors the theater-open handler in webapp/index.html). A
 * full-width 16:9 band with native controls on the app ground, then the
 * kicker and title in the hero's gold voice. Everything arrives as params
 * (src, poster, title, kicker) from lib/featured.ts, so there is no fetch.
 * Watch is an explicit request to hear it, so the player starts unmuted.
 * Focus is STATE that an effect turns into play/pause, never a focus cleanup
 * that touches the player: on Back the cleanup runs at unmount, after
 * useVideoPlayer has released the player, and pause() on a released player
 * throws into the commit phase and blanks the app. Same shape
 * as app/video/[contentId].tsx.
 */
import { Ionicons } from "@expo/vector-icons";
import { Image } from "expo-image";
import { useFocusEffect, useLocalSearchParams } from "expo-router";
import * as ScreenOrientation from "expo-screen-orientation";
import { VideoView, useVideoPlayer } from "expo-video";
import { useCallback, useEffect, useState } from "react";
import { Platform, Pressable, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { goBack } from "@/lib/navigation";
import { useScreenView } from "@/telemetry";
import { tokens } from "@/theme/tokens";
import { useTheme } from "@/theme/useTheme";

export default function TheaterScreen() {
  const t = useTheme();
  const { width } = useWindowDimensions();
  const params = useLocalSearchParams<{ src: string; poster: string; title: string; kicker: string }>();
  const src = params.src ?? "";
  const poster = params.poster ?? "";
  const title = params.title ?? "";
  const kicker = params.kicker ?? "";
  useScreenView("theater", { title });

  const player = useVideoPlayer(src || null, (p) => {
    // Watch is an explicit request to hear it.
    p.muted = false;
    p.play();
  });
  // Poster latches off on the first painted frame and stays off: keyed to
  // the live status it would come back over the native controls on every
  // Android rebuffer or scrub. Same latch as the feed's posterHidden.
  const [posterHidden, setPosterHidden] = useState(false);

  // Focus owns playback: pause when covered, resume on return.
  const [focused, setFocused] = useState(true);
  useFocusEffect(
    useCallback(() => {
      setFocused(true);
      return () => setFocused(false);
    }, []),
  );
  useEffect(() => {
    if (focused) player.play();
    else player.pause();
  }, [focused, player]);

  // iOS turns the app itself for fullscreen (Android's fullscreen activity
  // rotates on its own, see fullscreenOptions): landscape on enter, upright
  // again on exit, and upright on the way out of the screen in case the exit
  // event never came (a background kill mid-fullscreen). The app is otherwise
  // portrait-only (app.json orientation + the expo-screen-orientation
  // initialOrientation), so nothing else ever sees a sideways layout. A
  // refused turn (iPad multitasking) is ignored: the cut still plays upright.
  const turn = useCallback((lock: ScreenOrientation.OrientationLock) => {
    if (Platform.OS !== "ios") return;
    void ScreenOrientation.lockAsync(lock).catch(() => undefined);
  }, []);
  useEffect(() => () => turn(ScreenOrientation.OrientationLock.PORTRAIT_UP), [turn]);

  const bandH = Math.round((width * 9) / 16);

  return (
    <SafeAreaView edges={["top"]} style={[styles.screen, { backgroundColor: t.bg }]}>
      <View style={styles.header}>
        <Pressable
          onPress={() => goBack()}
          accessibilityRole="button"
          accessibilityLabel="Back"
          hitSlop={8}
          style={styles.back}
        >
          <Ionicons name="chevron-back" size={26} color={t.text} />
          <Text style={[styles.backLabel, { color: t.text }]}>Back</Text>
        </Pressable>
      </View>

      <View style={[styles.band, { height: bandH }]}>
        {/* Explicit pixel size: the web player ignores absoluteFill alone. */}
        <VideoView
          player={player}
          nativeControls
          fullscreenOptions={{
            enable: true,
            // Fullscreen turns the phone sideways for these 16:9 cuts and
            // comes back to portrait on exit. Android's
            // fullscreen activity takes the orientation itself, and turning
            // the phone upright again leaves fullscreen. iOS keeps the
            // player's default mask (every orientation) and the app's own
            // lock decides, in the enter/exit handlers below: a landscape-
            // only player presented while the app still allows portrait
            // only would share no orientation with it, and that is an iOS
            // exception, not a no-op.
            orientation: Platform.OS === "android" ? "landscape" : "default",
            autoExitOnRotate: Platform.OS === "android",
          }}
          onFullscreenEnter={() => turn(ScreenOrientation.OrientationLock.LANDSCAPE)}
          onFullscreenExit={() => turn(ScreenOrientation.OrientationLock.PORTRAIT_UP)}
          contentFit="contain"
          surfaceType="textureView"
          style={{ width, height: bandH }}
          onFirstFrameRender={() => setPosterHidden(true)}
        />
        {/* Poster until the first frame paints, then unmounted for good so
            taps reach the native controls. Contain, like the player under
            it: Big Noon Kickoff is 4:3, and a cover poster would jump to a
            pillarboxed frame at handoff. */}
        {poster && !posterHidden ? (
          <Image
            source={{ uri: poster }}
            contentFit="contain"
            cachePolicy="memory-disk"
            style={styles.poster}
          />
        ) : null}
      </View>

      <View style={styles.copy}>
        {kicker ? <Text style={styles.kicker}>{kicker.toUpperCase()}</Text> : null}
        <Text style={styles.title}>{title.toUpperCase()}</Text>
        <Text style={[styles.hint, { color: t.subtext }]}>Tap the video for controls</Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },
  header: {
    paddingHorizontal: tokens.spacing.md,
    paddingVertical: tokens.spacing.sm,
  },
  back: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
  },
  backLabel: {
    fontFamily: tokens.font.semibold,
    fontSize: 15,
  },
  band: {
    width: "100%",
    backgroundColor: "#000000",
    overflow: "hidden",
  },
  poster: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  copy: {
    paddingHorizontal: tokens.spacing.lg,
    paddingTop: tokens.spacing.lg,
    gap: tokens.spacing.xs,
  },
  // The site's .hero-kicker: gold Barlow 600 (displayBold is the nearest
  // bundled weight), 15px, .24em tracking = 3.6, uppercase. No phone
  // override on the site.
  kicker: {
    color: tokens.color.gold,
    fontFamily: tokens.font.displayBold,
    fontSize: 15,
    letterSpacing: 3.6,
  },
  title: {
    color: "#ffffff",
    fontFamily: tokens.font.extrabold,
    fontSize: tokens.text.title,
    lineHeight: tokens.text.title + 4,
    letterSpacing: 0.5,
  },
  hint: {
    fontFamily: tokens.font.regular,
    fontSize: 13,
    marginTop: tokens.spacing.sm,
  },
});
