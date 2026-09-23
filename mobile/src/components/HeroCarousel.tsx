/**
 * Full-bleed hero carousel — the HBO Max-style immersive hero from the
 * Full Bleed layout: edge-to-edge art at ~85% of the
 * viewport running behind the status bar and the floated top bar, with the
 * whole text stack compressed into the lower third in strict order —
 * provenance eyebrow, title lockup as art (never system text when a mark
 * exists), one status line (red LIVE pill replaces it during a live window,
 * never both), one middle-dot metadata line, ONE gold CTA. Manual swipe only:
 * timed auto-rotation is the one part of the pattern the research said not to
 * copy. Dots overlay the art's bottom edge, max five slides.
 *
 * Playback architecture: ONE shared
 * player for the whole carousel. The active slide's reel is the only source
 * ever loaded — swiping replaces it, so cross-slide audio is structurally
 * impossible. The video surface mounts immediately for the active slide and
 * sits UNDER the poster; the poster hides once the shared player reports
 * readyToPlay, so there is never a black slide. Mount-first matters on web:
 * the web player only loads once a view's element attaches, so gating the
 * mount on readiness deadlocks there (poster forever, video never). Index
 * tracking rides onScroll (fires on every platform), not just momentum-end.
 * The sound chip is a real button; slide taps navigate.
 *
 * Crop discipline: 9:16 media renders at full reel height inside the slide,
 * offset so the kept window sits FACE_BIAS above center, where faces live.
 *
 * Featured mode: Home passes the website's four featured slides
 * (lib/featured.ts) and they replace the network and event slides. The
 * horizontal episodes render the site's phone layout: a bare 16:9 band on
 * the #060608 ground, letterboxed (contain) so the 4:3 Big Noon cut is never
 * cropped, with no echo, glow or scrim (the site hides all three for hz
 * slides). Reels keep the full-height 9:16 cover frame. The
 * copy stack is the site's: gold kicker, title, dek, gold Watch pill. The
 * NIL STAR tab still passes events with network={false}, unchanged.
 *
 * Compact mode: when EVERY slide is a 16:9 band there is no tall reel to fill 85% of the
 * viewport, and the old share left a dead gap between the band and the copy.
 * The hero then sizes itself to its content instead: the band sits just
 * under the floated top bar (at chipTop) and the copy block's reserved room
 * follows it, capped at the full-bleed share on short windows. One 9:16
 * slide in the set restores the tall hero, since slide height is uniform.
 */
import type { EventCard } from "@niltv/types";
import { Ionicons } from "@expo/vector-icons";
import { useEvent } from "expo";
import { Image } from "expo-image";
import { LinearGradient } from "expo-linear-gradient";
import { useFocusEffect, useRouter } from "expo-router";
import { VideoView, useVideoPlayer } from "expo-video";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  FlatList,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";

import { CompetitionMark, hasCompetitionMark, NILSTAR_ASPECT } from "@/components/Brand";
import { PressableScale } from "@/components/PressableScale";
import { config } from "@/config";
import { useCountdown } from "@/hooks/useCountdown";
import { eventArtUrl, inSubmissions, introPosterUrl } from "@/lib/events";
import type { FeaturedSlide } from "@/lib/featured";
import { fitDisplaySize } from "@/lib/fitTitle";
import { hapticSelect } from "@/lib/haptics";
import { promoForEvent, type PromoAction } from "@/lib/promoCopy";
import { track } from "@/telemetry";
import { tokens } from "@/theme/tokens";

/** Hero art height as a share of the viewport (Full Bleed spec layer 1). */
const HERO_VIEWPORT_SHARE = 0.85;
/** Kept crop window sits slightly above center — where faces are. */
const FACE_BIAS = 0.42;
/** 16:9 band's vertical centre as a share of the slide (the site's hreel). */
const BAND_CENTER = 0.38;
/** Governed cap: pagination dots stop meaning anything past five slides. */
const MAX_SLIDES = 5;
/**
 * Compact (all-wide) heroes: room under the band for the copy stack — kicker,
 * title, up-to-two-line dek, Watch pill, its margins, the 34dp dot clearance —
 * plus a breath between band and kicker. The copy is bottom-anchored, so any
 * slack shows up as that breath, never as overlap.
 */
const WIDE_COPY_BLOCK = 240;

/** Player mutation outside the component body (react-hooks/immutability). */
function applyMuted(player: { muted: boolean }, muted: boolean) {
  player.muted = muted;
}

interface Slide {
  key: string;
  /** Provenance eyebrow (the DC STUDIOS | HBO ORIGINAL slot). */
  eyebrow: string;
  /** Title — rendered as a lockup image when a competition mark exists. */
  title: string;
  /**
   * One editorial status line; suppressed while `live` shows the red pill.
   * Featured slides have none (the site's hero carries no status).
   */
  status?: string;
  live: boolean;
  meta?: string;
  /** One line under the title (site .hero-dek), featured slides only. */
  dek?: string;
  /** "16:9" = letterboxed band on the plain ground; default "9:16" full frame. */
  aspect?: "16:9" | "9:16";
  /** False hides the sound chip (the hz loops carry no audio track). */
  hasAudio?: boolean;
  /** Site hero styling: kicker size, dek, gold Watch pill with a play glyph. */
  featured?: boolean;
  videoUrl?: string;
  posterUrl?: string;
  /** Exactly one CTA per hero (the Full Bleed rule: no "+" button). */
  cta: { label: string; onPress: () => void };
  onCardPress: () => void;
}

function SlideView({
  slide,
  width,
  slideH,
  active,
  compact,
  mountVideo,
  videoReady,
  player,
  muted,
  chipTop,
  onToggleMute,
}: {
  slide: Slide;
  width: number;
  slideH: number;
  active: boolean;
  /** All-wide hero: the band hangs from chipTop instead of BAND_CENTER. */
  compact: boolean;
  /** Attach the video surface (active slide with a reel) — see header note. */
  mountVideo: boolean;
  videoReady: boolean;
  player: ReturnType<typeof useVideoPlayer>;
  muted: boolean;
  /** Keeps the sound chip clear of the floated top bar. */
  chipTop: number;
  onToggleMute: () => void;
}) {
  const wide = slide.aspect === "16:9";
  const bandH = Math.round((width * 9) / 16);
  // 9:16: full-height frame, offset so the crop keeps the subject. On tall
  // heroes the slide itself can be taller than a 9:16 reel — never shorter.
  // 16:9: a band the width of the slide with its centre at BAND_CENTER
  // of the slide height, on the plain ground, media letterboxed inside it.
  // Compact: the band's top edge clears the floated top bar at chipTop.
  const mediaH = wide ? bandH : Math.max(slideH, Math.round((width * 16) / 9));
  // Competition lockup at hero scale (84 reads like a thumbnail). Marks
  // render in a 1.6:1 box, so cap the height by the copy column on narrow
  // windows.
  // CompetitionMark weight-balances wide marks (NIL Star renders at 0.65x this
  // height, so NILSTAR_ASPECT * 0.65, about 1.91x this height wide with the
  // 742x252 site mark) — cap by that widest rendered box.
  const lockupH = Math.min(120, Math.round((width - tokens.spacing.lg * 2) / (NILSTAR_ASPECT * 0.65)));
  // Text titles size to the longest line so a two-line title never ellipsizes
  // on a phone (the site's ht-feat caps its size against the width).
  const titleSize = fitDisplaySize(slide.title, width - tokens.spacing.lg * 2, tokens.text.display);
  const top = wide
    ? compact
      ? chipTop
      : Math.round(slideH * BAND_CENTER - bandH / 2)
    : -Math.max(0, Math.round((mediaH - slideH) * FACE_BIAS));
  const frame = { position: "absolute" as const, top, left: 0, width, height: mediaH };
  const showChip = active && slide.videoUrl !== undefined && slide.hasAudio !== false;

  return (
    <View style={{ width }}>
      <PressableScale
        scaleTo={1}
        onPress={slide.onCardPress}
        accessibilityLabel={slide.title}
        style={[styles.slide, { height: slideH }, wide ? styles.slideWide : null]}
      >
        {mountVideo ? (
          // Mounted under the poster as soon as the slide is active — the web
          // player only loads once this element attaches. `frame` carries
          // explicit pixel dimensions, so the web <video> is sized correctly.
          // Wide: contain on black, the site's phone .hreel .hero-video; Big
          // Noon Kickoff is 4:3 and cover would crop a quarter of it.
          <VideoView
            player={player}
            nativeControls={false}
            contentFit={wide ? "contain" : "cover"}
            surfaceType="textureView"
            style={[frame, wide ? styles.band : null]}
          />
        ) : null}
        {slide.posterUrl ? (
          <Image
            source={{ uri: slide.posterUrl }}
            contentFit={wide ? "contain" : "cover"}
            transition={tokens.motion.slow}
            cachePolicy="memory-disk"
            style={[frame, wide ? styles.band : null, mountVideo && videoReady ? styles.posterHidden : null]}
          />
        ) : null}
        {/* Top band keeps the floated bar legible; the deep bottom band melts
            the art into the app ground so the first rail reads as a seam.
            Not on wide slides: the band sits on the ground already and the
            site hides glow, echo and scrim for hz on phones. */}
        {wide ? null : (
          <LinearGradient
            colors={[
              "rgba(6,6,8,0.42)",
              "rgba(6,6,8,0)",
              "rgba(6,6,8,0.52)",
              "rgba(6,6,8,0.92)",
              "#060608",
            ]}
            locations={[0, 0.3, 0.62, 0.86, 1]}
            style={[StyleSheet.absoluteFill, { pointerEvents: "none" }]}
          />
        )}
        {showChip ? (
          <PressableScale
            onPress={(e) => {
              e?.stopPropagation?.();
              onToggleMute();
            }}
            accessibilityRole="button"
            accessibilityLabel={muted ? "Unmute" : "Mute"}
            hitSlop={10}
            style={[styles.soundChip, { top: chipTop }]}
          >
            <Ionicons name={muted ? "volume-mute" : "volume-high"} size={13} color="#ffffff" />
          </PressableScale>
        ) : null}

        {/* The lower-third stack, in the spec's strict order. */}
        <View style={styles.copy}>
          <Text style={[styles.eyebrow, slide.featured ? styles.kicker : null]}>
            {slide.eyebrow.toUpperCase()}
          </Text>
          {hasCompetitionMark(slide.title) ? (
            <CompetitionMark title={slide.title} height={lockupH} style={styles.lockup} />
          ) : (
            <Text
              numberOfLines={2}
              adjustsFontSizeToFit
              minimumFontScale={0.6}
              style={[styles.title, { fontSize: titleSize, lineHeight: titleSize + 4 }]}
            >
              {slide.title.toUpperCase()}
            </Text>
          )}
          {slide.dek ? (
            // Three lines of headroom for a hard-broken dek on 360dp phones;
            // the hz deks run two.
            <Text style={styles.dek} numberOfLines={2} adjustsFontSizeToFit minimumFontScale={0.75}>
              {slide.dek}
            </Text>
          ) : null}
          {slide.live ? (
            <View style={styles.livePill}>
              <View style={styles.liveDot} />
              <Text style={styles.liveLabel}>VOTING LIVE NOW</Text>
            </View>
          ) : slide.status ? (
            <Text style={styles.status}>{slide.status.toUpperCase()}</Text>
          ) : null}
          {slide.meta ? <Text style={styles.meta}>{slide.meta}</Text> : null}
          <PressableScale
            onPress={(e) => {
              e?.stopPropagation?.();
              slide.cta.onPress();
            }}
            accessibilityRole="button"
            accessibilityLabel={slide.cta.label}
            style={[styles.cta, slide.featured ? styles.ctaPill : null]}
          >
            {slide.featured ? <Ionicons name="play" size={14} color={tokens.color.ink} /> : null}
            <Text style={styles.ctaLabel}>{slide.cta.label}</Text>
          </PressableScale>
        </View>
      </PressableScale>
    </View>
  );
}

export function HeroCarousel({
  events,
  onNotify,
  featured,
  network = true,
  chipTop = tokens.spacing.md,
}: {
  events: EventCard[];
  onNotify: (eventId: string) => void;
  /**
   * The site's featured slides (lib/featured.ts). When given they REPLACE
   * the network slide and the event slides (Home).
   */
  featured?: FeaturedSlide[];
  /** Lead with the network brand slide (Home); competition tabs pass false. */
  network?: boolean;
  /** Top offset for the sound chip, clearing the floated top bar. */
  chipTop?: number;
}) {
  const router = useRouter();
  const { width, height } = useWindowDimensions();
  const [index, setIndex] = useState(0);
  const [muted, setMuted] = useState(true);
  const indexRef = useRef(0);
  const listRef = useRef<FlatList<Slide>>(null);

  // ── The one shared player: only the active slide's reel is ever loaded ──
  const player = useVideoPlayer(null, (p) => {
    p.loop = true;
    p.muted = true;
  });
  const { status } = useEvent(player, "statusChange", { status: player.status });
  const videoReady = status === "readyToPlay";

  const spotlight = events.find((ev) => inSubmissions(ev) || ev.status === "live");
  const countdown = useCountdown(
    spotlight?.status === "live"
      ? spotlight.endsAt
      : spotlight && inSubmissions(spotlight)
        ? spotlight.entriesCloseAt
        : undefined,
  );

  const resolveAction = (action: PromoAction, ev: EventCard) => ({
    label: action.label,
    onPress: () => {
      if (action.type === "submit") {
        // Enter Now routes to the event page — the page owns the
        // actual entry-form link; the hero never opens the form directly.
        track("card_tap", { eventId: ev.id, from: "hero_enter" });
        router.push({ pathname: "/event/[eventId]", params: { eventId: ev.id } });
        return;
      }
      if (action.type === "notify") {
        onNotify(ev.id);
        return;
      }
      track("card_tap", { eventId: ev.id, from: "hero" });
      router.push({ pathname: "/event/[eventId]", params: { eventId: ev.id } });
    },
  });

  // Watch = the whole card and the CTA alike. Horizontal episodes open the
  // theater with the full cut; the NIL Star reel is an API content item, so
  // it opens the app's own vertical player in its channel's feed.
  const watchFeatured = (f: FeaturedSlide) => () => {
    if (f.watch.kind === "content") {
      track("card_tap", { contentId: f.watch.contentId, from: "hero_featured" });
      router.push({
        pathname: "/video/[contentId]",
        params: { contentId: f.watch.contentId, channelId: f.watch.channelId },
      });
      return;
    }
    track("card_tap", { featured: f.key, from: "hero_featured" });
    router.push({
      pathname: "/theater",
      params: { src: f.watch.src, poster: f.watch.poster, title: f.watch.title, kicker: f.watch.kicker },
    });
  };

  const slides: Slide[] = (
    featured
      ? featured.map((f): Slide => {
          const watch = watchFeatured(f);
          return {
            key: f.key,
            eyebrow: f.kicker,
            title: f.title,
            dek: f.dek,
            aspect: f.aspect,
            hasAudio: f.hasAudio,
            featured: true,
            live: false,
            videoUrl: f.loopUrl,
            posterUrl: f.posterUrl,
            cta: { label: "Watch", onPress: watch },
            onCardPress: watch,
          };
        })
      : [
          ...(network
            ? [
                {
                  key: "network",
                  eyebrow: "The NIL TV Network",
                  title: "This Is NIL TV",
                  status: "Now Streaming",
                  live: false,
                  meta: "Competitions · Channels · Featured",
                  videoUrl: `${config.apiBase}/video/brand/niltv-v18-720.mp4`,
                  posterUrl: introPosterUrl(`${config.apiBase}/video/brand/niltv-v18-720.mp4`),
                  cta: {
                    label: "▶ Browse the Network",
                    onPress: () => router.push("/(tabs)/channels"),
                  },
                  onCardPress: () => router.push("/(tabs)/channels"),
                } satisfies Slide,
              ]
            : []),
          ...events.map((ev): Slide => {
            const promo = promoForEvent(ev, countdown);
            const goEvent = () => {
              track("card_tap", { eventId: ev.id, from: "hero" });
              router.push({ pathname: "/event/[eventId]", params: { eventId: ev.id } });
            };
            return {
              key: ev.id,
              // Always the event title so the competition LOCKUP renders (the
              // title-as-art rule) — the winner's name moves to the metadata line.
              title: ev.title,
              eyebrow: promo.pill,
              status: promo.stat,
              live: ev.status === "live",
              meta:
                ev.status === "ended" && ev.winnerName
                  ? `${ev.winnerName} · Your First NIL Star`
                  : promo.meta,
              videoUrl: ev.introVideoUrl,
              posterUrl: eventArtUrl(ev),
              cta: resolveAction(promo.primary, ev),
              onCardPress: goEvent,
            };
          }),
        ]
  ).slice(0, MAX_SLIDES);

  // ── Height: full-bleed share, or compact when every slide is a 16:9 band ──
  const compact = slides.length > 0 && slides.every((s) => s.aspect === "16:9");
  const fullH = Math.round(height * HERO_VIEWPORT_SHARE);
  const slideH = compact
    ? Math.min(fullH, chipTop + Math.round((width * 9) / 16) + WIDE_COPY_BLOCK)
    : fullH;

  // ── Source follows the active slide (audio can never bleed) ─────────────
  const activeVideo = slides[index]?.videoUrl ?? null;
  const loadedRef = useRef<string | null>(null);
  // Focus is state an effect turns into play/pause, never a focus cleanup
  // that touches the player: at unmount the cleanup runs after useVideoPlayer
  // has released it, and pause() on a released player throws into the commit
  // phase (same pattern as app/theater.tsx). The ref is what the
  // in-flight replaceAsync reads.
  const [focused, setFocused] = useState(true);
  const focusedRef = useRef(true);
  useFocusEffect(
    useCallback(() => {
      focusedRef.current = true;
      setFocused(true);
      return () => {
        focusedRef.current = false;
        setFocused(false);
      };
    }, []),
  );
  useEffect(() => {
    if (loadedRef.current === activeVideo) return;
    loadedRef.current = activeVideo;
    player
      .replaceAsync(activeVideo)
      .then(() => {
        if (loadedRef.current === activeVideo && activeVideo && focusedRef.current) {
          player.play();
        }
      })
      .catch(() => {
        loadedRef.current = null;
      });
  }, [activeVideo, player]);
  useEffect(() => {
    applyMuted(player, muted);
  }, [muted, player]);
  useEffect(() => {
    if (focused) {
      if (loadedRef.current) player.play();
    } else {
      player.pause();
    }
  }, [focused, player]);

  return (
    <View>
      <FlatList
        ref={listRef}
        data={slides}
        keyExtractor={(s) => s.key}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        getItemLayout={(_, i) => ({ length: width, offset: width * i, index: i })}
        // onScroll (not momentum-end) so the active slide can never desync —
        // momentum events are unreliable on web and on interrupted swipes.
        onScroll={(e) => {
          const i = Math.round(e.nativeEvent.contentOffset.x / width);
          if (i !== indexRef.current && i >= 0 && i < slides.length) {
            indexRef.current = i;
            setIndex(i);
            hapticSelect();
          }
        }}
        scrollEventThrottle={32}
        renderItem={({ item, index: i }) => (
          <SlideView
            slide={item}
            width={width}
            slideH={slideH}
            active={i === index}
            compact={compact}
            mountVideo={i === index && item.videoUrl !== undefined}
            videoReady={videoReady}
            player={player}
            muted={muted}
            chipTop={chipTop}
            onToggleMute={() => setMuted(!muted)}
          />
        )}
      />
      {/* Dots overlay the art's bottom edge (manual swipe only — no timer). */}
      {slides.length > 1 ? (
        <View style={styles.dots}>
          {slides.map((s, i) => (
            <View key={s.key} style={[styles.dot, i === index && styles.dotOn]} />
          ))}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  slide: {
    width: "100%",
    backgroundColor: "#0c0c10",
    overflow: "hidden",
  },
  // Wide slides sit on the app ground: the site's phone .hero-slide{background:var(--bg)}.
  slideWide: {
    backgroundColor: "#060608",
  },
  // The letterbox behind contain-fit wide media (the site's background:#000).
  band: {
    backgroundColor: "#000000",
  },
  posterHidden: {
    opacity: 0,
  },
  soundChip: {
    position: "absolute",
    right: tokens.spacing.lg,
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: "rgba(6,6,8,0.55)",
    alignItems: "center",
    justifyContent: "center",
  },
  copy: {
    position: "absolute",
    left: tokens.spacing.lg,
    right: tokens.spacing.lg,
    // Clears the overlaid pagination dots.
    bottom: 34,
  },
  // Gold Barlow 700 on every slide: the site's kicker is gold everywhere.
  eyebrow: {
    color: tokens.color.gold,
    fontFamily: tokens.font.displayBold,
    fontSize: 10.5,
    letterSpacing: 1.6,
    marginBottom: tokens.spacing.sm,
  },
  // Featured slides take the site's .hero-kicker size and tracking: 15px,
  // .24em = 3.6. The site has no phone override for it.
  kicker: {
    fontSize: 15,
    letterSpacing: 3.6,
  },
  lockup: {
    marginBottom: tokens.spacing.sm,
  },
  title: {
    color: "#ffffff",
    fontFamily: tokens.font.extrabold,
    fontSize: tokens.text.display,
    lineHeight: tokens.text.display + 4,
    letterSpacing: 0.5,
    marginBottom: tokens.spacing.sm,
  },
  // The site's .hero-dek: Inter, dim.
  dek: {
    color: tokens.color.muted,
    fontFamily: tokens.font.regular,
    fontSize: 15,
    lineHeight: 20,
    marginTop: 4,
  },
  status: {
    color: "#ffffff",
    fontFamily: tokens.font.extrabold,
    fontSize: 14,
    lineHeight: 19,
    letterSpacing: 1.4,
  },
  livePill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    alignSelf: "flex-start",
    backgroundColor: "rgba(228,87,79,0.18)",
    borderWidth: 1,
    borderColor: "rgba(228,87,79,0.65)",
    borderRadius: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  liveDot: {
    width: 5,
    height: 5,
    borderRadius: 3,
    backgroundColor: "#e4574f",
  },
  liveLabel: {
    color: "#ffffff",
    fontFamily: tokens.font.extrabold,
    fontSize: 10,
    letterSpacing: 1,
  },
  meta: {
    color: "rgba(255,255,255,0.62)",
    fontFamily: tokens.font.semibold,
    fontSize: 14,
    lineHeight: 20,
    letterSpacing: 0.2,
    marginTop: 6,
  },
  cta: {
    alignSelf: "flex-start",
    backgroundColor: tokens.color.gold,
    borderRadius: 7,
    paddingVertical: 12,
    paddingHorizontal: 18,
    marginTop: tokens.spacing.md,
  },
  // The site's gold Watch pill: play glyph then label.
  ctaPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderRadius: 999,
    paddingVertical: 12,
    paddingHorizontal: 22,
  },
  ctaLabel: {
    color: tokens.color.ink,
    fontFamily: tokens.font.bold,
    fontSize: 14,
  },
  dots: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 12,
    flexDirection: "row",
    justifyContent: "center",
    gap: 6,
    pointerEvents: "none",
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: "rgba(255,255,255,0.35)",
  },
  dotOn: {
    width: 16,
    backgroundColor: tokens.color.gold,
  },
});
