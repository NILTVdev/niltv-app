/**
 * Channels tab, laid out like the site's channels page on a phone: the
 * network marquee, then the two-line hero title sized to fit the
 * width (never ellipsized), then the channels as a horizontal carousel (one
 * chan3 mark per channel with its "{School}'s Athletes" caption, Coming Soon
 * tiles trailing and unlinked), then one content shelf per live channel in
 * carousel order.
 */
import type { Channel, ContentCard } from "@niltv/types";
import { FlatList, Image, RefreshControl, ScrollView, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";

import { useChannels } from "@/api/hooks";
import { CHANNELS_GRID_HIDDEN, NETWORK_SOURCES, channelDescriptor, channelLogo } from "@/components/Brand";
import { ChannelShelf } from "@/components/ChannelShelf";
import { NetworkMarquee } from "@/components/NetworkMarquee";
import { PressableScale } from "@/components/PressableScale";
import { EmptyState, ErrorState } from "@/components/ScreenState";
import { RailSkeleton } from "@/components/Skeleton";
import { isComingSoon, rosterOrder } from "@/lib/channelLive";
import { fitDisplaySize } from "@/lib/fitTitle";
import { track, useScreenView } from "@/telemetry";
import { tokens } from "@/theme/tokens";
import { useTheme } from "@/theme/useTheme";

const HERO_TITLE = "Student Athlete Run Channels\nLocal Content Created Their Way";
/** Carousel tile: a chan3 mark over its caption, about three per phone width. */
const TILE_WIDTH = 132;

export default function ChannelsScreen() {
  const t = useTheme();
  const router = useRouter();
  const { width } = useWindowDimensions();
  useScreenView("channels");

  const channels = useChannels();
  // Live vs Coming Soon reads each channel's clipCount off /v1/channels, same
  // floor as the web builder (CAMPUS_LIVE_MIN), so the rule is exact for
  // every roster channel with no Home dependency. A channel with no count
  // (an older backend, fixtures) stays live, so the tab
  // never disables a channel because the mobile JS shipped first.
  //
  // The title is sized to its longest line up front (the site caps ht-sm
  // against the viewport for the same reason): it must hold two lines on
  // every phone and never fall back to an ellipsis.
  const heroSize = fitDisplaySize(HERO_TITLE, width - tokens.spacing.lg * 2, tokens.text.display);

  // Every tile lands on the one channel template — kind no
  // longer picks a page, so a legacy shell would render the same as
  // ingest-minted campus channels.
  const open = (id: string, name: string, from: "channels" | "channels_shelf") => {
    track("card_tap", { channelId: id, from });
    router.push({ pathname: "/channel/[channelId]", params: { channelId: id, name } });
  };
  const openClip = (clip: ContentCard) => {
    track("card_tap", { contentId: clip.id, from: "channels_shelf" });
    // channelId gives the feed its swipe context (this channel's list).
    router.push({
      pathname: "/video/[contentId]",
      params: { contentId: clip.id, channelId: clip.channelId },
    });
  };

  const renderTile = ({ item: c }: { item: Channel }) => {
    const logo = channelLogo(c.id);
    const descriptor = channelDescriptor(c.id);
    // Coming Soon: the same tile, unlinked, as on the web channels grid.
    const soon = isComingSoon(c);
    return (
      <PressableScale
        accessibilityRole="button"
        accessibilityLabel={soon ? `${c.name}, coming soon` : descriptor ? `${c.name}. ${descriptor}.` : c.name}
        accessibilityState={soon ? { disabled: true } : undefined}
        disabled={soon || undefined}
        onPress={soon ? undefined : () => open(c.id, c.name, "channels")}
        style={styles.cell}
      >
        <View style={styles.tile}>
          {logo !== undefined ? (
            <Image source={logo} style={styles.logo} resizeMode="contain" accessibilityIgnoresInvertColors />
          ) : (
            <Text numberOfLines={2} style={[styles.tileName, { color: t.text }]}>
              {c.name}
            </Text>
          )}
        </View>
        {/* One line, the site's caption: "{School}'s Athletes", Coming Soon,
            or the bare channel name as the fallback. */}
        <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8} style={styles.caption}>
          {soon ? "Coming Soon" : (descriptor ?? c.name)}
        </Text>
      </PressableScale>
    );
  };

  return (
    <SafeAreaView edges={["top"]} style={[styles.screen, { backgroundColor: t.bg }]}>
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            refreshing={channels.isRefetching}
            onRefresh={() => void channels.refetch()}
            tintColor={t.accent}
            colors={[t.accent]}
            progressBackgroundColor={t.surface}
          />
        }
      >
        {/* ── Hero: the network marquee, then the site's two-line title ──── */}
        <NetworkMarquee variant="hero" />
        <Text
          accessibilityRole="header"
          numberOfLines={2}
          adjustsFontSizeToFit
          minimumFontScale={0.6}
          style={[styles.heroTitle, { fontSize: heroSize, lineHeight: Math.round(heroSize * 1.02) }]}
        >
          {HERO_TITLE}
        </Text>

        {/* ── The channel carousel ─────────────────────────────────────── */}
        <Text style={styles.heading}>Channels</Text>

        {channels.isPending && !channels.data ? <RailSkeleton cardWidth={TILE_WIDTH} aspect="3:4" /> : null}
        {channels.isError && !channels.data ? (
          <View style={styles.gutter}>
            <ErrorState onRetry={() => void channels.refetch()} />
          </View>
        ) : null}

        {channels.data ? (() => {
          // Site order (CAMPUS_CHANNEL_ORDER, TrueBlue TV first) before
          // the split, so the carousel and the shelves both read TrueBlue
          // first; live channels keep that order and Coming Soon tiles trail.
          const roster = rosterOrder(
            channels.data.channels.filter((c) => !NETWORK_SOURCES.has(c.id) && !CHANNELS_GRID_HIDDEN.has(c.id)),
          );
          const live = roster.filter((c) => !isComingSoon(c));
          const carousel = [...live, ...roster.filter((c) => isComingSoon(c))];
          return carousel.length === 0 ? (
            <View style={styles.gutter}>
              <EmptyState message="Channels are on the way." />
            </View>
          ) : (
            <>
              <FlatList
                horizontal
                data={carousel}
                keyExtractor={(c) => c.id}
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.carousel}
                renderItem={renderTile}
              />

              {/* ── One shelf per live channel, carousel order ──────────── */}
              {live.map((c) => (
                <ChannelShelf
                  key={c.id}
                  channelId={c.id}
                  name={c.name}
                  onSeeAll={() => open(c.id, c.name, "channels_shelf")}
                  onOpenClip={openClip}
                />
              ))}
            </>
          );
        })() : null}
      </ScrollView>
    </SafeAreaView>
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
  gutter: {
    paddingHorizontal: tokens.spacing.lg,
  },
  // The site's h1.hero-title.ht-sm: Barlow 800, uppercase, white, tight
  // leading; the size is set inline against the width (see heroSize).
  heroTitle: {
    color: "#ffffff",
    fontFamily: tokens.font.display,
    letterSpacing: 0.5,
    textTransform: "uppercase",
    paddingHorizontal: tokens.spacing.lg,
    paddingTop: tokens.spacing.sm,
    marginBottom: tokens.spacing.md,
  },
  // The site's shelf title (cinema .shelf-title): Barlow Condensed
  // 700, 19px, .16em tracking (3px here), uppercase, gold.
  heading: {
    color: tokens.color.gold,
    fontFamily: tokens.font.displayBold,
    fontSize: 19,
    letterSpacing: 3,
    textTransform: "uppercase",
    paddingHorizontal: tokens.spacing.lg,
    paddingTop: tokens.spacing.sm,
    marginBottom: tokens.spacing.sm,
  },
  carousel: {
    paddingHorizontal: tokens.spacing.lg,
    gap: tokens.spacing.md,
  },
  cell: {
    width: TILE_WIDTH,
    alignItems: "center",
    gap: tokens.spacing.sm,
  },
  /**
   * Plate-less: the chan3 marks are drawn for the dark ground,
   * so the logo sits directly on the screen background — no box, no border.
   * minHeight keeps text-fallback cells row-aligned with logo cells.
   */
  tile: {
    width: "100%",
    minHeight: 84 + tokens.spacing.md * 2,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: tokens.spacing.md,
    paddingHorizontal: tokens.spacing.sm,
  },
  logo: {
    height: 84,
    width: "94%",
  },
  tileName: {
    fontFamily: tokens.font.extrabold,
    fontSize: 16,
    textAlign: "center",
  },
  /**
   * The site's channel caption (.chan-cap): Barlow Condensed 700,
   * uppercase, gold, centred, at the site's phone size (11px, .12em). One
   * style for all three captions: "{School}'s Athletes", Coming Soon
   * (.chan-cap-soon is the same type, gold), and the bare name fallback.
   */
  caption: {
    color: tokens.color.gold,
    fontFamily: tokens.font.displayBold,
    fontSize: 11,
    letterSpacing: 1.3,
    textAlign: "center",
    textTransform: "uppercase",
  },
});
