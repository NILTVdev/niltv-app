import { useRouter } from "expo-router";
import { Fragment, useRef, useState } from "react";
import { RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useChannels, useConfig, useHome } from "@/api/hooks";
import { requireAuth } from "@/auth/store";
import { NETWORK_SOURCES, channelLogoH } from "@/components/Brand";
import { HeroCarousel } from "@/components/HeroCarousel";
import { HeroTopBar } from "@/components/HeroTopBar";
import { NewsletterBand } from "@/components/NewsletterBand";
import { Rail } from "@/components/Rail";
import { EmptyState, ErrorState } from "@/components/ScreenState";
import { RailSkeleton } from "@/components/Skeleton";
import { StarPicker } from "@/components/StarPicker";
import { config } from "@/config";
import { useNotifyMe } from "@/hooks/useNotifyMe";
import { athleteParams } from "@/lib/athleteRoute";
import { categoryRailsFor } from "@/lib/categoryRails";
import { featuredSlides } from "@/lib/featured";
import { posterUrl } from "@/lib/featuredRails";
import { schoolMeta } from "@/lib/format";
import { track, useScreenView } from "@/telemetry";
import { tokens } from "@/theme/tokens";
import { useTheme } from "@/theme/useTheme";

export default function HomeScreen() {
  const t = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const home = useHome();
  // The ambassadors rail (and its See more tile) only lights up with the
  // directory flag — no ambassador support yet, so it ships dark.
  const directoryOn = useConfig().data?.flags.ambassadorDirectory === true;
  useScreenView("home");
  const notifyMe = useNotifyMe();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const noteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showNote = () => {
    setNote("You're on the list. We'll ping you when voting opens.");
    if (noteTimer.current) clearTimeout(noteTimer.current);
    noteTimer.current = setTimeout(() => setNote(null), 3000);
  };

  const data = home.data;
  // Empty rails (channels without clips yet) and the ambassadors rail (no
  // ambassador support yet — same flag as the directory) render nothing
  // rather than stale headers/fixture people. The Coming Soon floor is a
  // Channels-tab rule (lib/channelLive); Home rails whatever the handler
  // sends, unchanged.
  const rails = (data?.rails ?? []).filter(
    (rail) => rail.items.length > 0 && (rail.key !== "ambassadors" || directoryOn),
  );

  // Where the scroll crosses from network content into the campus channel
  // rails, a section break marks the hand-off between local channels and
  // NIL Star, headed "Channels" (not "Campus"). A rail is campus when its channel is — every rail
  // is single-channel, so the first card answers for the rail. NIL Star's
  // channel is kind "campus" in the data (ingest-minted) but is a network
  // source — NETWORK_SOURCES keeps the break below its rail.
  const channels = useChannels();
  const campusIds = new Set(
    (channels.data?.channels ?? [])
      .filter((c) => c.kind === "campus" && !NETWORK_SOURCES.has(c.id))
      .map((c) => c.id),
  );
  // Channel rails head with the channel's horizontal lockup, like the
  // site's channel rails. Network rails
  // (NIL TV, NIL Star) keep their text title.
  const railChannelId = (rail: (typeof rails)[number]): string | undefined => {
    const id = rail.kind === "content" ? rail.items[0]?.channelId : undefined;
    return id && !NETWORK_SOURCES.has(id) ? id : undefined;
  };
  // Every content rail ends in a See more tile into the rail's full
  // list (no head link, one way in): channel rails open their channel
  // page, the two network rails open their tab (Featured, NIL Star). One
  // card_tap shape for all of them.
  const railSeeAll = (rail: (typeof rails)[number]): (() => void) | undefined => {
    const channelId = railChannelId(rail);
    if (channelId) {
      return () => {
        track("card_tap", { channelId, from: "home_rail_seeall" });
        router.push({ pathname: "/channel/[channelId]", params: { channelId, name: rail.title } });
      };
    }
    if (rail.key === "featured") {
      return () => {
        track("card_tap", { rail: rail.key, from: "home_rail_seeall" });
        router.push("/(tabs)/featured");
      };
    }
    if (rail.key === "nilstar") {
      return () => {
        track("card_tap", { rail: rail.key, from: "home_rail_seeall" });
        router.push("/(tabs)/nilstar");
      };
    }
    return undefined;
  };
  const firstCampusRailKey = rails.find(
    (rail) => rail.kind === "content" && campusIds.has(rail.items[0]?.channelId ?? ""),
  )?.key;

  // The Timeless Category rails sit between the network rails and the
  // Channels section, the site homepage's order. A clip the hero or a rail
  // above already shows is skipped (one appearance per clip, the site's
  // rule), and a category left under the floor stays hidden.
  const heroSlides = featuredSlides(config.apiBase);
  const campusAt = rails.findIndex((rail) => rail.key === firstCampusRailKey);
  const claimed = new Set<string>(heroSlides.map((s) => s.key));
  for (const rail of campusAt < 0 ? rails : rails.slice(0, campusAt)) {
    if (rail.kind === "content") for (const c of rail.items) claimed.add(c.id);
  }
  const categories = categoryRailsFor(claimed);
  // No See more tile: a category has no full-list screen yet, the same as
  // the Featured tab's curated rails. No channel context on the card, so the
  // feed opens on the clip's detail.
  const categoryRails = categories.map((rail) => (
    <Rail
      key={`category-${rail.title}`}
      title={rail.title}
      items={rail.cards.map((c) => ({
        id: c.id,
        title: c.title,
        imageUrl: posterUrl(config.apiBase, c.id),
        onPress: () => {
          track("card_tap", { contentId: c.id, rail: rail.title, from: "home_category" });
          router.push({ pathname: "/video/[contentId]", params: { contentId: c.id } });
        },
      }))}
    />
  ));

  return (
    // No top safe-area edge: the hero art runs behind the status bar (Full
    // Bleed spec layer 1) and the floated bar pads itself with the inset.
    <View style={[styles.screen, { backgroundColor: t.bg }]}>
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            refreshing={home.isRefetching}
            onRefresh={() => void home.refetch()}
            tintColor={t.accent}
            colors={[t.accent]}
            progressBackgroundColor={t.surface}
          />
        }
      >
        {/* Full-bleed hero with the top bar floated over the art. */}
        <View>
          {/* The site's featured episodes, not the event list, minus the
              NIL Star reel, so the hero runs compact. */}
          <HeroCarousel
            featured={heroSlides}
            events={[]}
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
        {note ? (
          <View style={styles.bannerWrap}>
            <Text style={[styles.note, { color: t.subtext }]}>{note}</Text>
          </View>
        ) : null}

        {home.isPending && !data ? (
          /* Rails skeleton — the hero above renders immediately. */
          <>
            <RailSkeleton />
            <RailSkeleton cardWidth={150} aspect="3:4" />
          </>
        ) : null}
        {home.isError && !data ? <ErrorState onRetry={() => void home.refetch()} /> : null}

        {data ? (
          <>

            {rails.map((rail) => (
              <Fragment key={rail.key}>
                {rail.key === firstCampusRailKey ? (
                  <>
                    {categoryRails}
                    <View style={styles.campusBreak}>
                      <View style={[styles.campusRule, { backgroundColor: t.line }]} />
                      <Text style={styles.campusHeading}>Channels</Text>
                    </View>
                  </>
                ) : null}
                {rail.kind === "content" ? (
                  <Rail
                    title={rail.title}
                    titleLogo={railChannelId(rail) ? channelLogoH(railChannelId(rail) ?? "") : undefined}
                    onSeeAll={railSeeAll(rail)}
                    // Titles only, the site's card rule: no
                    // channel or creator line under the title.
                    items={rail.items.map((c) => ({
                      id: c.id,
                      title: c.title,
                      imageUrl: c.thumbUrl,
                      onPress: () => {
                        track("card_tap", { contentId: c.id, from: `home_${rail.key}` });
                        // channelId gives the feed its swipe context (this channel's list).
                        router.push({
                          pathname: "/video/[contentId]",
                          params: { contentId: c.id, channelId: c.channelId },
                        });
                      },
                    }))}
                  />
                ) : (
                  <Rail
                    title={rail.title}
                    aspect="3:4"
                    cardWidth={150}
                    onSeeAll={
                      rail.key === "ambassadors" && directoryOn
                        ? () => router.push("/ambassadors")
                        : undefined
                    }
                    items={rail.items.map((a) => ({
                      id: a.id,
                      title: a.name,
                      meta: schoolMeta(a.school, a.sport),
                      imageUrl: a.avatarUrl,
                      showPlay: false,
                      onPress: () => {
                        track("card_tap", { athleteId: a.id, from: `home_${rail.key}` });
                        router.push({ pathname: "/athlete/[id]", params: athleteParams(a) });
                      },
                    }))}
                  />
                )}
              </Fragment>
            ))}
            {/* No campus rails (yet): the categories close out the rails. */}
            {campusAt < 0 ? categoryRails : null}

            {/* Home band newsletter entry point (spec §5.6). */}
            <NewsletterBand source="home_band" />

            {data.hero.state === "none" && rails.length === 0 && categories.length === 0 ? (
              <EmptyState message="Nothing here yet. Check back soon." />
            ) : null}
          </>
        ) : null}
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
  // The network → campus hand-off: hairline, then a section heading a tier
  // above the rail titles so the zone change reads while scrolling.
  campusBreak: {
    marginTop: tokens.spacing.xl * 1.5,
    paddingHorizontal: tokens.spacing.lg,
    gap: tokens.spacing.lg,
  },
  campusRule: {
    height: StyleSheet.hairlineWidth,
    alignSelf: "stretch",
  },
  // Gold uppercase like the site's shelf titles.
  campusHeading: {
    color: tokens.color.gold,
    fontFamily: tokens.font.extrabold,
    fontSize: 22,
    letterSpacing: 2,
    textTransform: "uppercase",
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
