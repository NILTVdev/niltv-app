/**
 * Competitions tab (the "nilstar" route, labelled Competitions). It mirrors
 * the site's /competitions/ page on a phone, nothing more:
 *   1. The full-bleed competition hero, driven by the events list exactly as
 *      before (Season 1 recap: champion clip, "Season 2 arrives in 2027").
 *   2. "NIL Singing Star Season 1": the Top 20 in announcement order, the
 *      champion first, every card captioned with the finalist's NAME.
 *   3. "The Auditions": the 24 open-call entries and finalist originals,
 *      captioned with their API titles.
 * Both shelves come from hand-picked id lists (lib/competitions, kept in
 * lockstep with the site's build-sections.py) fetched one clip at a time
 * through useContentByIds. No calendar strip, no "Latest From" rail, no
 * per-event showcase carousels: the site has none of those.
 *
 * Between the hero and the shelves, a horizontal audition compilation
 * billboard (WideBillboard) appears by itself once
 * video/hz-nilstar-auditions/poster.jpg exists on the stage CDN: useAssetExists
 * HEADs it, and nothing renders until that answers true. The cut is uploaded
 * per stage by a maintainer (master-fs.mp4 first, poster.jpg last, so the probe only flips once the
 * theater source is up); no app release needed. The probe's answer is cached
 * six hours per device, so a viewer who opened this tab just before the
 * upload sees the billboard within that window. No heading sits between the
 * billboard and the shelves: the hero's dek already carries the Season 2
 * line.
 */
import type { EventCard } from "@niltv/types";
import { useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useEvents } from "@/api/hooks";
import { requireAuth } from "@/auth/store";
import { HeroCarousel } from "@/components/HeroCarousel";
import { HeroTopBar } from "@/components/HeroTopBar";
import { Rail } from "@/components/Rail";
import { ErrorState } from "@/components/ScreenState";
import { BannerSkeleton, RailSkeleton, RowsSkeleton } from "@/components/Skeleton";
import { StarPicker } from "@/components/StarPicker";
import { WideBillboard } from "@/components/WideBillboard";
import { useAssetExists } from "@/hooks/useAssetExists";
import { useContentByIds } from "@/hooks/useContentByIds";
import { useNotifyMe } from "@/hooks/useNotifyMe";
import {
  AUDITION_IDS,
  AUDITIONS_SHELF_TITLE,
  finalistTitle,
  SEASON1_FINALISTS,
  SEASON1_SHELF_TITLE,
} from "@/lib/competitions";
import { config } from "@/config";
import { inSubmissions } from "@/lib/events";
import { nilStarAuditionsBillboard, nilStarBillboard } from "@/lib/featured";
import { track, useScreenView } from "@/telemetry";
import { tokens } from "@/theme/tokens";
import { useTheme } from "@/theme/useTheme";

const FINALIST_IDS = SEASON1_FINALISTS.map((f) => f.id);
const FINALIST_BY_ID = new Map(SEASON1_FINALISTS.map((f) => [f.id, f]));

/**
 * The two site shelves. Each one waits for its own clips: a skeleton row
 * while nothing has loaded yet, nothing at all if every id failed (a
 * tombstoned clip 404s and simply drops out of the rail, so the shelf never
 * shows a hole where the site shows a card).
 */
function CompetitionShelves() {
  const router = useRouter();
  const finalists = useContentByIds(FINALIST_IDS);
  const auditions = useContentByIds(AUDITION_IDS);
  // No channelId: these are hand-picked ids, so the video screen opens in its
  // detail mode (the clip + related) instead of paging a channel list first.
  const open = (contentId: string, from: string) => {
    track("card_tap", { contentId, from });
    router.push({ pathname: "/video/[contentId]", params: { contentId } });
  };
  return (
    <>
      {finalists.cards.length > 0 ? (
        <Rail
          title={SEASON1_SHELF_TITLE}
          items={finalists.cards.map((c) => {
            const f = FINALIST_BY_ID.get(c.id);
            return {
              id: c.id,
              title: f ? finalistTitle(f) : c.title,
              imageUrl: c.thumbUrl,
              onPress: () => open(c.id, "competitions_season1"),
            };
          })}
        />
      ) : finalists.pending ? (
        <RailSkeleton />
      ) : null}
      {auditions.cards.length > 0 ? (
        <Rail
          title={AUDITIONS_SHELF_TITLE}
          items={auditions.cards.map((c) => ({
            id: c.id,
            title: c.title,
            imageUrl: c.thumbUrl,
            onPress: () => open(c.id, "competitions_auditions"),
          }))}
        />
      ) : auditions.pending ? (
        <RailSkeleton />
      ) : null}
    </>
  );
}

export default function NilStarScreen() {
  const t = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const events = useEvents();
  const data = events.data;
  useScreenView("nilstar");
  const notifyMe = useNotifyMe();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const noteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (noteTimer.current) clearTimeout(noteTimer.current);
    },
    [],
  );
  const showNote = () => {
    setNote("You're on the list. We'll ping you when voting opens.");
    if (noteTimer.current) clearTimeout(noteTimer.current);
    noteTimer.current = setTimeout(() => setNote(null), 3000);
  };

  // Hero order: the active competition first (submissions/live), then
  // upcoming, then past seasons — the site's ordering.
  const ordered = [...(data?.events ?? [])].sort((a, b) => {
    const rank = (e: EventCard) =>
      inSubmissions(e) ? 0 : e.status === "live" ? 0 : e.status === "upcoming" ? 1 : 2;
    return rank(a) - rank(b);
  });
  // With no competition open, the hero is the site's own Season 1 billboard
  // (the NIL Star slide Home also carries: champion kicker, dek, Watch), not
  // the generic recap slide, so the tab reads exactly like /competitions/
  // An open or upcoming event takes the hero back over.
  const current = ordered.find((e) => e.status !== "ended");
  const seasonBillboard = current ? undefined : [nilStarBillboard(config.apiBase)];
  // The audition compilation shows only once its poster is on the CDN.
  const auditions = nilStarAuditionsBillboard(config.apiBase);
  const hasAuditions = useAssetExists(auditions.posterUrl);

  return (
    // No top safe-area edge: the hero art runs behind the status bar and the
    // floated bar pads itself with the inset (Full Bleed spec layer 1).
    <View style={[styles.screen, { backgroundColor: t.bg }]}>
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            refreshing={events.isRefetching}
            onRefresh={() => void events.refetch()}
            tintColor={t.accent}
            colors={[t.accent]}
            progressBackgroundColor={t.surface}
          />
        }
      >
        {/* Full-bleed competition hero — no network slide on this tab. */}
        <View>
          <HeroCarousel
            events={ordered}
            featured={seasonBillboard}
            network={false}
            onNotify={(eventId) => notifyMe(eventId, showNote)}
            chipTop={insets.top + 48}
          />
          <HeroTopBar
            onMail={() => {
              track("newsletter_band_tap", { source: "topbar" });
              router.push({ pathname: "/newsletter", params: { source: "topbar" } });
            }}
            onStar={() => requireAuth(() => setPickerOpen(true))}
          />
        </View>
        {hasAuditions === true ? <WideBillboard slide={auditions} /> : null}
        {note ? (
          <View style={styles.bannerWrap}>
            <Text style={[styles.note, { color: t.subtext }]}>{note}</Text>
          </View>
        ) : null}

        {events.isPending && !data ? (
          <View style={styles.head}>
            <BannerSkeleton />
            <RowsSkeleton rows={2} />
          </View>
        ) : null}
        {events.isError && !data ? <ErrorState onRetry={() => void events.refetch()} /> : null}

        {/* The site always shows both shelves; they do not depend on /v1/events
            (the hero above falls back to the Season 1 billboard by itself). */}
        <CompetitionShelves />
      </ScrollView>
      <StarPicker visible={pickerOpen} onClose={() => setPickerOpen(false)} />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },
  content: {
    flexGrow: 1,
    paddingBottom: tokens.spacing.xl * 2,
  },
  head: {
    paddingHorizontal: tokens.spacing.lg,
  },
  bannerWrap: {
    paddingHorizontal: tokens.spacing.lg,
  },
  note: {
    fontFamily: tokens.font.semibold,
    fontSize: 13,
    marginTop: tokens.spacing.sm,
    textAlign: "center",
  },
});
