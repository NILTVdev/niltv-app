import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect } from "expo-router";
import { VideoView, useVideoPlayer } from "expo-video";
import { useCallback, useEffect, useState } from "react";
import { StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";

import { PressableScale } from "@/components/PressableScale";
import { config } from "@/config";
import { tokens } from "@/theme/tokens";

/** Player mutation outside the component body (react-hooks/immutability). */
function applyMuted(player: { muted: boolean }, muted: boolean) {
  player.muted = muted;
}

/** Both cuts of the network intro, 720p mobile encodes (11–14.5 MB, faststart). */
const SOURCES = {
  wide: { file: "niltv-wide-v4-720.mp4", aspect: 16 / 9 },
  portrait: { file: "niltv-v18-720.mp4", aspect: 9 / 16 },
} as const;

/**
 * The NILTV network intro reel as mobile encodes (the 130 MB broadcast
 * masters are too heavy to stream here). Autoplay muted loop, tap for
 * sound. Pauses whenever the screen loses focus. `portrait` is the 9:16 V18 cut — full-frame on a phone.
 * Focus is STATE that an effect turns into play/pause, never a focus cleanup
 * that touches the player: on a popped route the cleanup runs at unmount,
 * after useVideoPlayer has released the player, and pause() on a released
 * player throws into the commit phase and blanks the app (the same pattern
 * as app/theater.tsx and HeroCarousel).
 */
export function SizzleReel({
  variant = "wide",
  style,
}: {
  variant?: keyof typeof SOURCES;
  style?: StyleProp<ViewStyle>;
}) {
  const source = SOURCES[variant];
  const [muted, setMuted] = useState(true);
  const player = useVideoPlayer(`${config.apiBase}/video/brand/${source.file}`, (p) => {
    p.loop = true;
    p.muted = true;
    p.play();
  });
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

  return (
    <PressableScale
      scaleTo={1}
      accessibilityRole="button"
      accessibilityLabel={muted ? "Unmute the intro reel" : "Mute the intro reel"}
      onPress={() => {
        applyMuted(player, !muted);
        setMuted(!muted);
      }}
      style={[styles.wrap, { aspectRatio: source.aspect }, style]}
    >
      <VideoView
        player={player}
        nativeControls={false}
        contentFit="cover"
        surfaceType="textureView"
        style={[StyleSheet.absoluteFill, styles.surface]}
      />
      <View style={styles.soundChip}>
        <Ionicons name={muted ? "volume-mute" : "volume-high"} size={14} color="#ffffff" />
      </View>
    </PressableScale>
  );
}

const styles = StyleSheet.create({
  surface: {
    width: "100%",
    height: "100%",
  },
  wrap: {
    width: "100%",
    borderRadius: 14,
    overflow: "hidden",
    backgroundColor: "#000000",
    marginBottom: 18,
  },
  soundChip: {
    position: "absolute",
    right: tokens.spacing.md,
    bottom: tokens.spacing.md,
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: "rgba(6,6,8,0.55)",
    alignItems: "center",
    justifyContent: "center",
    pointerEvents: "none",
  },
});
