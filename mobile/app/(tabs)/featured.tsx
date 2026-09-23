import { useRouter } from "expo-router";
import { useState } from "react";
import { RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useHome } from "@/api/hooks";
import { requireAuth } from "@/auth/store";
import { HeroCarousel } from "@/components/HeroCarousel";
import { HeroTopBar } from "@/components/HeroTopBar";
import { Rail } from "@/components/Rail";
import { RailSkeleton } from "@/components/Skeleton";
import { StarPicker } from "@/components/StarPicker";
import { config } from "@/config";
import type { FeaturedSlide } from "@/lib/featured";
import { FEATURED_RAILS, posterUrl } from "@/lib/featuredRails";
import { newThisWeek } from "@/lib/newThisWeek";
import { track, useScreenView } from "@/telemetry";
import { tokens } from "@/theme/tokens";
import { useTheme } from "@/theme/useTheme";

/**
 * The Featured tab mirrors the site's /featured/ page on a phone: the site's
 * hero reel, then
 * the live "New This Week" shelf built off /v1/home (lib/newThisWeek), then
 * the site's curated shelves as synced by scripts/sync-featured-rails.mjs
 * (lib/featuredRails). Cards are titles only, like the site's reel captions.
 */

/** The site hero: one 9:16 reel, the gold Watch plays it in the feed. */
const HERO_ID = "ig-17961794499169577";

function heroSlide(cdn: string): FeaturedSlide {
  const dir = `${cdn}/video/${HERO_ID}`;
  return {
    key: "featured-hero",
    kicker: "Our Athletes",
    title: "NIL TV Athletes\nCreating Content Their Way",
    dek: "New Drops Daily",
    aspect: "9:16",
    loopUrl: `${dir}/master.mp4`,
    posterUrl: `${dir}/poster.jpg`,
    hasAudio: true,
    watch: { kind: "content", contentId: HERO_ID, channelId: "ch-chapelhilltv" },
  };
}

export default function FeaturedScreen() {
  const t = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const home = useHome();
  useScreenView("featured");
  const [pickerOpen, setPickerOpen] = useState(false);

  const data = home.data;
  const live = data ? newThisWeek(data.rails, new Date()) : null;

  return (
    // No top safe-area edge: the hero art runs behind the status bar and the
    // floated bar pads itself with the inset, same as Home.
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
        <View>
          <HeroCarousel
            featured={[heroSlide(config.apiBase)]}
            events={[]}
            onNotify={() => {}}
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

        {/* The live shelf: skeleton while /v1/home loads, nothing on error.
            The curated rails below never wait on the network. */}
        {home.isPending && !data ? <RailSkeleton /> : null}
        {live && live.cards.length > 0 ? (
          <Rail
            title={live.title}
            items={live.cards.map((c) => ({
              id: c.id,
              title: c.title,
              imageUrl: c.thumbUrl,
              onPress: () => {
                track("card_tap", { contentId: c.id, from: "featured_new" });
                router.push({
                  pathname: "/video/[contentId]",
                  params: { contentId: c.id, channelId: c.channelId },
                });
              },
            }))}
          />
        ) : null}

        {/* The site's curated shelves. No channel context on the card, so the
            feed opens on the clip's detail (the clip + its related). */}
        {FEATURED_RAILS.map((rail) => (
          <Rail
            key={rail.title}
            title={rail.title}
            items={rail.cards.map((c) => ({
              id: c.id,
              title: c.title,
              imageUrl: posterUrl(config.apiBase, c.id),
              onPress: () => {
                track("card_tap", { contentId: c.id, from: "featured_curated" });
                router.push({ pathname: "/video/[contentId]", params: { contentId: c.id } });
              },
            }))}
          />
        ))}
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
});
