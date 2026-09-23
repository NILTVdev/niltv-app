/**
 * The submissions-phase opener, full-bleed: the intro reel IS the screen — it
 * fills the first viewport under the status bar, and the state moves into one
 * overlay stack at the bottom: the prize as the headline, the entries-close
 * line, and the gold Submit CTA. The back chevron and event title ride the
 * top scrim, so the screen-level header and the lockup row stand down on this
 * phase. Text rides the media here on purpose; the scrims are part of the
 * layout, so legibility never depends on the frame.
 * No SUBMISSIONS OPEN pill — the open window reads from the
 * meta line and the live CTA. Falls back to the network sizzle when the
 * event has no intro reel of its own.
 *
 * No autoplay: the reel waits parked on a chosen cover
 * frame under a play button; tapping plays from the top with sound. After
 * that, tapping the media toggles sound, as before.
 *
 * Type discipline: two hero sizes — the display headline and the meta line
 * (the CTA label is button furniture).
 */
import { useEventListener } from "expo";
import { Ionicons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import { useFocusEffect } from "expo-router";
import { VideoView, useVideoPlayer } from "expo-video";
import { useCallback, useRef, useState } from "react";
import {
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { PressableScale } from "@/components/PressableScale";
import { config } from "@/config";
import { track } from "@/telemetry";
import { tokens } from "@/theme/tokens";
import { useTheme } from "@/theme/useTheme";

/**
 * The paused cover frame, picked by frame survey: the gold
 * NIL TV mark fully on screen, face sharp between words. Applies to the
 * network sizzle fallback too — revisit if the intro reel changes.
 */
const COVER_AT_SECONDS = 9.6;

/** Player mutation outside the component body (react-hooks/immutability). */
function applyMuted(player: { muted: boolean }, muted: boolean) {
  player.muted = muted;
}

function applyCoverFrame(player: { currentTime: number }) {
  player.currentTime = COVER_AT_SECONDS;
}

/**
 * First tap: from the top, with sound — an explicit play is a request to hear
 * it. replay() (not seek-then-play): on Android, a currentTime write and a
 * play() issued in the same tick can leave ExoPlayer parked in a buffering
 * pause — the tap looks dead.
 */
function startPlayback(player: { muted: boolean; replay: () => void }) {
  player.muted = false;
  player.replay();
}

export function SubmissionsHero({
  title,
  prize,
  videoUrl,
  countdownLine,
  ctaLabel = "Submit Your Entry",
  onSubmit,
  onBack,
  style,
}: {
  /** Event title — the overlaid header line, and the headline when there is no prize. */
  title: string;
  /** Prize string ("$10,000") — leads the headline in gold over GRAND PRIZE. */
  prize?: string;
  /** The event's own intro reel; falls back to the network sizzle. */
  videoUrl?: string;
  countdownLine?: string;
  ctaLabel?: string;
  onSubmit: () => void;
  onBack: () => void;
  style?: StyleProp<ViewStyle>;
}) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const source = videoUrl ?? `${config.apiBase}/video/brand/niltv-v18-720.mp4`;
  const [muted, setMuted] = useState(false);
  const [playing, setPlaying] = useState(false);
  const startedRef = useRef(false);
  const player = useVideoPlayer(source, (p) => {
    p.loop = true;
    p.muted = true;
    applyCoverFrame(p);
  });
  // A seek before the media is loaded is dropped on some platforms — re-park
  // on the cover frame once the reel is actually ready (unless play beat it).
  // The pause also cancels web's unrequested autoplay (upstream expo-video
  // quirk: the web player starts on load), so every platform parks the same.
  useEventListener(player, "statusChange", ({ status }) => {
    if (status === "readyToPlay" && !startedRef.current) {
      player.pause();
      applyCoverFrame(player);
    }
  });
  // The play affordance tracks the player, not a one-shot flag: whenever the
  // reel is paused (parked, or back from a pushed screen) the play button is
  // the offer; while it runs, the sound chip is.
  useEventListener(player, "playingChange", ({ isPlaying }) => {
    setPlaying(isPlaying);
  });
  useFocusEffect(
    useCallback(() => {
      if (startedRef.current) player.play();
      return () => player.pause();
    }, [player]),
  );

  return (
    <View style={[styles.hero, { height }, style]}>
      {/* ── The reel owns the viewport; a tap plays, then toggles sound ── */}
      <PressableScale
        scaleTo={1}
        accessibilityRole="button"
        accessibilityLabel={
          playing
            ? muted
              ? "Unmute the intro reel"
              : "Mute the intro reel"
            : "Play the intro reel"
        }
        onPress={() => {
          if (!playing) {
            if (!startedRef.current) {
              startedRef.current = true;
              setMuted(false);
              try {
                startPlayback(player);
              } catch (error) {
                // A native player call that throws would otherwise kill the
                // tap silently in release — report it, leave the reel parked.
                track("js_error", {
                  where: "submissions_hero_play",
                  message: String(error).slice(0, 300),
                });
              }
            } else {
              player.play();
            }
            return;
          }
          applyMuted(player, !muted);
          setMuted(!muted);
        }}
        style={StyleSheet.absoluteFill}
      >
        <VideoView
          player={player}
          nativeControls={false}
          contentFit="cover"
          // TextureView: SurfaceView z-order blacks out stacked/underlying
          // video surfaces on Android (the "back lands on a black page" bug).
          surfaceType="textureView"
          style={[StyleSheet.absoluteFill, styles.surface]}
        />
        {/* Scrims are layout, not video: header legible up top, the stack
            melts into the page ground below. */}
        <LinearGradient
          colors={["rgba(6,6,8,0.66)", "transparent"]}
          style={styles.scrimTop}
        />
        <LinearGradient
          colors={["transparent", "rgba(6,6,8,0.52)", t.bg]}
          locations={[0, 0.45, 1]}
          style={styles.scrimBottom}
        />
        {playing ? (
          <View style={[styles.soundChip, { top: insets.top + 52 }]}>
            <Ionicons name={muted ? "volume-mute" : "volume-high"} size={14} color="#ffffff" />
          </View>
        ) : (
          <View pointerEvents="none" style={styles.playWrap}>
            <View style={styles.playCircle}>
              <Ionicons name="play" size={26} color={tokens.color.ink} style={styles.playIcon} />
            </View>
          </View>
        )}
      </PressableScale>

      {/* ── Overlaid header: back + title on the top scrim ──────────────── */}
      <View pointerEvents="box-none" style={[styles.header, { top: insets.top + tokens.spacing.sm }]}>
        <PressableScale
          onPress={onBack}
          accessibilityRole="button"
          accessibilityLabel="Back"
          hitSlop={8}
          style={styles.back}
        >
          <Ionicons name="chevron-back" size={24} color="#ffffff" />
        </PressableScale>
        <Text numberOfLines={1} style={styles.headerTitle}>
          {title}
        </Text>
      </View>

      {/* ── The overlay stack: headline, meta, CTA ──────────────────────── */}
      <View pointerEvents="box-none" style={[styles.stack, { paddingBottom: insets.bottom + tokens.spacing.lg }]}>
        {prize ? (
          <Text style={styles.headline}>
            <Text style={styles.headlinePrize}>{prize}{"\n"}</Text>
            Grand Prize
          </Text>
        ) : (
          <Text style={styles.headline}>{title}</Text>
        )}
        {countdownLine ? (
          <Text style={[styles.count, { color: t.subtext }]}>{countdownLine}</Text>
        ) : null}
        <PressableScale
          onPress={onSubmit}
          accessibilityRole="button"
          accessibilityLabel={ctaLabel}
          style={styles.cta}
        >
          <Text style={styles.ctaLabel}>{ctaLabel}</Text>
        </PressableScale>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // No explicit width: the hero stretches with the column, so the negative
  // gutter margins widen it to the true screen edges (an explicit 100% is
  // resolved before those margins and leaves a bar down one side).
  hero: {
    alignSelf: "stretch",
    backgroundColor: "#000000",
  },
  surface: {
    width: "100%",
    height: "100%",
  },
  scrimTop: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    height: 130,
    pointerEvents: "none",
  },
  scrimBottom: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    height: "56%",
    pointerEvents: "none",
  },
  header: {
    position: "absolute",
    left: tokens.spacing.md,
    right: tokens.spacing.lg,
    flexDirection: "row",
    alignItems: "center",
    gap: tokens.spacing.sm,
  },
  back: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: "rgba(6,6,8,0.4)",
    alignItems: "center",
    justifyContent: "center",
  },
  headerTitle: {
    color: "#ffffff",
    fontFamily: tokens.font.extrabold,
    fontSize: 19,
    flex: 1,
  },
  soundChip: {
    position: "absolute",
    right: tokens.spacing.md,
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: "rgba(6,6,8,0.55)",
    alignItems: "center",
    justifyContent: "center",
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
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: tokens.color.gold,
    alignItems: "center",
    justifyContent: "center",
  },
  playIcon: {
    marginLeft: 3,
  },
  stack: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    gap: tokens.spacing.md,
    paddingHorizontal: tokens.spacing.lg,
  },
  headline: {
    color: "#ffffff",
    fontFamily: tokens.font.display,
    fontSize: tokens.text.hero,
    lineHeight: tokens.text.hero + 2,
    letterSpacing: 0.2,
    textTransform: "uppercase",
  },
  headlinePrize: {
    color: tokens.color.gold,
  },
  count: {
    fontFamily: tokens.font.semibold,
    fontSize: tokens.text.meta,
  },
  cta: {
    backgroundColor: tokens.color.gold,
    borderRadius: 9,
    paddingVertical: 13,
    alignItems: "center",
  },
  ctaLabel: {
    color: tokens.color.ink,
    fontFamily: tokens.font.bold,
    fontSize: tokens.text.body,
  },
});
