/**
 * Season recap as a network title page: the champion presented like an
 * Original Series — full-bleed
 * hero art under the status bar, display-type name, gold series eyebrow,
 * metadata row, synopsis, Play + the Instagram post link, then the season
 * arc as an episode rail and the finalist reel grid. All playback happens
 * in the shared full-screen ReelViewer: Play opens on the champion, the
 * grid opens on the tapped finalist, and swiping moves through the field.
 */
import type { EventEntity } from "@niltv/types";
import { Ionicons } from "@expo/vector-icons";
import { Image } from "expo-image";
import { LinearGradient } from "expo-linear-gradient";
import { useState } from "react";
import {
  Linking,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";

import { NewsletterBand } from "@/components/NewsletterBand";
import { Pill } from "@/components/Pill";
import { PressableScale } from "@/components/PressableScale";
import { ReelViewer, type ReelItem } from "@/components/ReelViewer";
import { nilSchool, schoolMeta } from "@/lib/format";
import { goBack } from "@/lib/navigation";
import { track } from "@/telemetry";
import { tokens } from "@/theme/tokens";
import { useTheme } from "@/theme/useTheme";

type Showcase = NonNullable<EventEntity["showcase"]>;
type Finalist = Showcase["finalists"][number];

/** "Bella Calvanese" → "BELLA\nCALVANESE" (last name gets its own line). */
function displayName(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length < 2) return name.toUpperCase();
  const last = parts.pop() as string;
  return `${parts.join(" ")}\n${last}`.toUpperCase();
}

/**
 * Grid card = poster only. Playback happens in the full-screen ReelViewer —
 * a 170px card cover-crops the reel out of frame; the viewer letterboxes it.
 */
function ReelCard({ finalist, onOpen }: { finalist: Finalist; onOpen: () => void }) {
  const t = useTheme();
  return (
    <PressableScale
      onPress={finalist.videoUrl ? onOpen : undefined}
      accessibilityRole="button"
      accessibilityLabel={`Play ${finalist.name}'s audition`}
      style={[styles.gridCard, { backgroundColor: t.surface, borderColor: t.line }]}
    >
      <View style={styles.reelFrame}>
        {finalist.photoUrl ? (
          <Image
            source={{ uri: finalist.photoUrl }}
            style={StyleSheet.absoluteFill}
            contentFit="cover"
            transition={tokens.motion.base}
            cachePolicy="memory-disk"
          />
        ) : (
          <View style={[StyleSheet.absoluteFill, { backgroundColor: t.inset }]} />
        )}
        {finalist.videoUrl ? (
          <View style={styles.reelPlayWrap}>
            <View style={styles.reelPlay}>
              <Ionicons name="play" size={16} color="#1a1a1f" style={{ marginLeft: 2 }} />
            </View>
          </View>
        ) : null}
      </View>
      <Text numberOfLines={1} style={[styles.gridName, { color: t.text }]}>
        {finalist.name}
      </Text>
      <Text numberOfLines={3} style={[styles.gridMeta, { color: t.subtext }]}>
        {schoolMeta(finalist.school, finalist.sport)}
      </Text>
    </PressableScale>
  );
}

export function ShowcaseTitlePage({
  event,
  refreshing,
  onRefresh,
}: {
  event: EventEntity;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const showcase = event.showcase as Showcase;
  const winner = showcase.winner;

  // Viewer list: the champion leads, then the field in grid order — Play
  // opens at 0, a grid card at its index + 1, and swiping crosses the field.
  const reelItems: ReelItem[] = [
    {
      name: winner.name,
      meta: `${schoolMeta(winner.school, winner.sport)} · Champion`,
      photoUrl: winner.posterUrl,
      videoUrl: winner.videoUrl,
    },
    ...showcase.finalists.map((f) => ({
      name: f.name,
      meta: schoolMeta(f.school, f.sport),
      photoUrl: f.photoUrl,
      videoUrl: f.videoUrl,
    })),
  ];
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  const openViewer = (index: number, from: string) => {
    track("card_tap", { from, eventId: event.id });
    setViewerIndex(index);
  };

  const finalistTotal = showcase.finalists.length + 1; // grid + the champion
  const synopsis =
    `A national fan-vote competition for college athletes. ${winner.name} of ` +
    `${nilSchool(winner.school)} was crowned the first ever NIL STAR, outlasting a ` +
    `nationwide field of ${finalistTotal} finalists to take home the ${event.prize ?? "grand"} prize.`;

  const heroH = Math.round(width * 1.2);

  return (
    <SafeAreaView edges={[]} style={[styles.screen, { backgroundColor: t.bg }]}>
      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={t.accent}
            colors={[t.accent]}
            progressBackgroundColor={t.surface}
          />
        }
      >
        {/* ── Full-bleed hero: art under the status bar, name over the scrim ── */}
        <PressableScale
          scaleTo={1}
          onPress={winner.videoUrl ? () => openViewer(0, "recap_hero") : undefined}
          accessibilityLabel={`Play ${winner.name}'s winner announcement`}
          style={[styles.hero, { height: heroH }]}
        >
          {winner.posterUrl ? (
            <Image
              source={{ uri: winner.posterUrl }}
              style={StyleSheet.absoluteFill}
              contentFit="cover"
              transition={tokens.motion.slow}
              cachePolicy="memory-disk"
            />
          ) : (
            <View style={[StyleSheet.absoluteFill, { backgroundColor: t.surface }]} />
          )}
          {/* Scrims: legible status bar up top, hero melts into the page below. */}
          <LinearGradient
            colors={["rgba(6,6,8,0.6)", "transparent"]}
            style={styles.scrimTop}
          />
          <LinearGradient
            colors={["transparent", "rgba(6,6,8,0.45)", "#060608"]}
            locations={[0, 0.55, 1]}
            style={styles.scrimBottom}
          />

          <PressableScale
            onPress={() => goBack()}
            accessibilityRole="button"
            accessibilityLabel="Back"
            hitSlop={8}
            style={[styles.back, { top: insets.top + tokens.spacing.sm }]}
          >
            <Ionicons name="chevron-back" size={24} color="#ffffff" />
          </PressableScale>

          <View style={styles.heroFoot}>
            <View style={styles.seriesBadge}>
              <Ionicons name="star" size={10} color={tokens.color.gold} />
              <Text style={styles.seriesBadgeText}>NIL STAR ORIGINAL SERIES</Text>
            </View>
            <Text style={styles.name}>{displayName(winner.name)}</Text>
          </View>
        </PressableScale>

        {/* ── Title block ──────────────────────────────────────────────── */}
        <View style={styles.body}>
          <Text style={[styles.eyebrow, { color: t.accent }]}>
            MEET THE FIRST EVER NIL STAR · SEASON 1
          </Text>

          <Text style={[styles.synopsis, { color: t.text }]}>{synopsis}</Text>

          <View style={styles.actions}>
            {winner.videoUrl ? (
              <PressableScale
                onPress={() => openViewer(0, "recap_play")}
                accessibilityRole="button"
                accessibilityLabel="Play winner announcement"
                style={styles.playBtn}
              >
                <Ionicons name="play" size={16} color="#0c0c10" />
                <Text style={styles.playLabel}>Play</Text>
              </PressableScale>
            ) : null}
            {winner.postUrl ? (
              <PressableScale
                onPress={() => {
                  track("card_tap", { from: "recap_instagram", eventId: event.id });
                  void Linking.openURL(winner.postUrl as string).catch(() => undefined);
                }}
                accessibilityRole="link"
                accessibilityLabel="See the post on Instagram"
                hitSlop={8}
              >
                <Text style={[styles.igLink, { color: t.text }]}>See the Post on Instagram →</Text>
              </PressableScale>
            ) : null}
          </View>
        </View>

        {/* ── Season arc: the episode rail ─────────────────────────────── */}
        {event.milestones && event.milestones.length > 0 ? (
          <>
            <Text style={[styles.section, { color: t.text }]}>
              Season 1 · Road to the Crown
            </Text>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.rail}
            >
              <View style={[styles.epCard, styles.epCardCrowned, { backgroundColor: t.surface }]}>
                <Pill label="NEW CROWNED" />
                <Text style={[styles.epTitle, { color: t.text }]}>
                  Finale · Crowning the Champion
                </Text>
              </View>
              {event.milestones.map((m) => (
                <View
                  key={m.date + m.label}
                  style={[styles.epCard, { backgroundColor: t.surface, borderColor: t.line }]}
                >
                  <Text style={[styles.epDate, { color: t.accent }]}>{m.date.toUpperCase()}</Text>
                  <Text style={[styles.epTitle, { color: t.text }]}>{m.label}</Text>
                </View>
              ))}
              {event.prize ? (
                <View style={[styles.epCard, { backgroundColor: t.surface, borderColor: t.line }]}>
                  <Text style={[styles.epDate, { color: t.accent }]}>GRAND PRIZE</Text>
                  <Text style={[styles.epTitle, { color: t.text }]}>{event.prize} Awarded</Text>
                </View>
              ) : null}
            </ScrollView>
          </>
        ) : null}

        {/* ── The field: 2-up poster grid → full-screen viewer ─────────── */}
        {showcase.finalists.length > 0 ? (
          <>
            <Text style={[styles.section, { color: t.text }]}>The Top {finalistTotal}</Text>
            <View style={styles.grid}>
              <ReelCard
                finalist={{
                  name: winner.name,
                  school: winner.school,
                  sport: winner.sport,
                  photoUrl: winner.posterUrl,
                  videoUrl: winner.videoUrl,
                }}
                onOpen={() => openViewer(0, "recap_reel")}
              />
              {showcase.finalists.map((f, i) => (
                <ReelCard
                  key={f.name}
                  finalist={f}
                  onOpen={() => openViewer(i + 1, "recap_reel")}
                />
              ))}
            </View>
          </>
        ) : null}

        <View style={styles.body}>
          <NewsletterBand
            source="recap"
            title="Don't miss the next one"
            copy="Get the next NIL STAR voting window in your inbox."
          />
        </View>
      </ScrollView>

      {viewerIndex !== null ? (
        <ReelViewer
          items={reelItems}
          startIndex={viewerIndex}
          onClose={() => setViewerIndex(null)}
        />
      ) : null}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },
  scroll: {
    paddingBottom: tokens.spacing.xl * 2,
  },
  hero: {
    width: "100%",
  },
  scrimTop: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    height: 120,
    pointerEvents: "none",
  },
  scrimBottom: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    height: "62%",
    pointerEvents: "none",
  },
  back: {
    position: "absolute",
    left: tokens.spacing.md,
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: "rgba(6,6,8,0.4)",
    alignItems: "center",
    justifyContent: "center",
  },
  heroFoot: {
    position: "absolute",
    left: tokens.spacing.lg,
    right: tokens.spacing.lg,
    bottom: tokens.spacing.md,
    pointerEvents: "none",
  },
  seriesBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginBottom: tokens.spacing.sm,
  },
  seriesBadgeText: {
    color: "#f5f5f7",
    fontFamily: tokens.font.extrabold,
    fontSize: tokens.text.label,
    letterSpacing: 1.6,
  },
  name: {
    color: "#ffffff",
    fontFamily: tokens.font.extrabold,
    fontSize: tokens.text.hero,
    lineHeight: tokens.text.hero + 2,
    letterSpacing: 0.2,
  },
  body: {
    paddingHorizontal: tokens.spacing.lg,
  },
  eyebrow: {
    fontFamily: tokens.font.extrabold,
    fontSize: tokens.text.meta,
    letterSpacing: 1.2,
    marginTop: tokens.spacing.sm,
  },
  synopsis: {
    fontFamily: tokens.font.regular,
    fontSize: tokens.text.body,
    lineHeight: 22,
    marginTop: tokens.spacing.md,
  },
  actions: {
    flexDirection: "row",
    alignItems: "center",
    gap: tokens.spacing.lg,
    marginTop: tokens.spacing.lg,
  },
  playBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "#ffffff",
    borderRadius: 6,
    paddingVertical: 12,
    paddingHorizontal: 26,
  },
  playLabel: {
    color: "#0c0c10",
    fontFamily: tokens.font.bold,
    fontSize: tokens.text.body,
  },
  igLink: {
    fontFamily: tokens.font.semibold,
    fontSize: tokens.text.meta,
    textDecorationLine: "underline",
  },
  section: {
    fontFamily: tokens.font.extrabold,
    fontSize: tokens.text.section,
    marginTop: tokens.spacing.xl,
    marginBottom: tokens.spacing.md,
    paddingHorizontal: tokens.spacing.lg,
  },
  rail: {
    gap: tokens.spacing.md,
    paddingHorizontal: tokens.spacing.lg,
  },
  epCard: {
    width: 156,
    borderWidth: 1,
    borderRadius: tokens.radius,
    padding: tokens.spacing.md,
    gap: tokens.spacing.sm,
    justifyContent: "flex-start",
  },
  epCardCrowned: {
    borderColor: tokens.color.gold,
    alignItems: "flex-start",
  },
  epDate: {
    fontFamily: tokens.font.extrabold,
    fontSize: tokens.text.label,
    letterSpacing: 1,
  },
  epTitle: {
    fontFamily: tokens.font.bold,
    fontSize: tokens.text.meta,
    lineHeight: 18,
  },
  // Percentage columns wrap reliably at every viewport (a computed pixel
  // width rounded up by one broke to a single column on web).
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "space-between",
    rowGap: tokens.spacing.md,
    paddingHorizontal: tokens.spacing.lg,
  },
  gridCard: {
    width: "48.4%",
    borderWidth: 1,
    borderRadius: tokens.radius,
    padding: tokens.spacing.sm,
    gap: 4,
  },
  reelFrame: {
    width: "100%",
    aspectRatio: 9 / 16,
    borderRadius: tokens.radius - 4,
    overflow: "hidden",
    marginBottom: 4,
    backgroundColor: "#000000",
  },
  reelPlayWrap: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: "center",
    justifyContent: "center",
    pointerEvents: "none",
  },
  reelPlay: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: tokens.color.gold,
    alignItems: "center",
    justifyContent: "center",
  },
  gridName: {
    fontFamily: tokens.font.bold,
    fontSize: tokens.text.body,
  },
  gridMeta: {
    fontFamily: tokens.font.regular,
    fontSize: tokens.text.label,
  },
});
