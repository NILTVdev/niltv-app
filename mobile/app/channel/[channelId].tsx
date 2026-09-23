/**
 * The channel page: ONE template for every channel — campus,
 * network source, or a legacy shell like ch-trueblue — keyed by
 * channel id, replacing both the old horizontal-logo feed grid and the
 * channel-dressed athlete screen. Identity comes from the channel itself
 * (bundled logo art, sampled brand color, school caption); the ingest-minted
 * pseudo-profile (p-{account}) adds the @handle and makes Follow possible
 * when it exists; content pages through GET /v1/content?channelId. Real
 * people keep /athlete/[id] on the same layout family, so ambassadors can
 * join later without a new template.
 */
import type { ContentCard } from "@niltv/types";
import { Ionicons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import { useLocalSearchParams, useRouter } from "expo-router";
import {
  ActivityIndicator,
  FlatList,
  Image,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { useChannels, useContentList, useFollow, useMe, useProfile, useUnfollow } from "@/api/hooks";
import { Avatar } from "@/components/Avatar";
import { channelColor, channelDescriptor, channelLogo, channelLogoH } from "@/components/Brand";
import { Card, thumbGradient } from "@/components/Card";
import { EmptyState, ErrorState } from "@/components/ScreenState";
import { GoldButton } from "@/components/GoldButton";
import { goBack } from "@/lib/navigation";
import { requireAuth } from "@/auth/store";
import { track, useScreenView } from "@/telemetry";
import { tokens } from "@/theme/tokens";
import { useTheme } from "@/theme/useTheme";

const GRID_GAP = tokens.spacing.md;

export default function ChannelScreen() {
  const t = useTheme();
  const router = useRouter();
  const { width } = useWindowDimensions();
  const params = useLocalSearchParams<{ channelId: string; name?: string }>();
  const channelId = params.channelId ?? "";
  useScreenView("channel", { channelId });

  const channels = useChannels();
  const channel = channels.data?.channels.find((c) => c.id === channelId);
  const name = channel?.name ?? params.name ?? "Channel";
  const logo = channelLogo(channelId);
  // The site's channel head is the wide chanh lockup itself
  // (h1.hero-title.logo-title); the text name is the fallback.
  const logoH = channelLogoH(channelId);
  const accent = channelColor(channelId);
  // The site's channel dek: "{School}'s Athletes".
  const schoolLine = channelId ? (channelDescriptor(channelId) ?? "") : "";

  // The channel's pseudo-profile carries the @handle and receives follows.
  // Legacy shells (ch-trueblue) have none — those bits simply hide.
  const profileId = channelId.startsWith("ch-") ? `p-${channelId.slice(3)}` : "";
  const profile = useProfile(profileId);
  const handle = profile.data?.handle;
  const handleLine = handle ? (handle.startsWith("@") ? handle : `@${handle}`) : "";
  const followable = profile.data !== undefined;

  const me = useMe();
  const follow = useFollow();
  const unfollow = useUnfollow();
  const isFollowing = me.data?.follows.includes(profileId) ?? false;
  const busy = follow.isPending || unfollow.isPending;
  const toggleFollow = () =>
    requireAuth(() => {
      if (isFollowing) unfollow.mutate(profileId);
      else follow.mutate(profileId);
    });

  const list = useContentList(channelId);
  const clips: ContentCard[] = list.data?.pages.flatMap((page) => page.items) ?? [];
  // floor() so two cards + gap can never exceed the row by a subpixel.
  const cardWidth = Math.floor((width - tokens.spacing.lg * 2 - GRID_GAP) / 2);

  const header = (
    <>
      {/* ── Cover band in the channel's own color ──────────────────────── */}
      <View style={styles.cover}>
        <LinearGradient
          colors={accent !== undefined ? ([accent, t.bg] as const) : thumbGradient(channelId || name)}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={StyleSheet.absoluteFill}
        />
        <SafeAreaView edges={["top"]}>
          <Pressable
            onPress={() => goBack()}
            accessibilityRole="button"
            accessibilityLabel="Back"
            style={styles.back}
          >
            <Ionicons name="chevron-back" size={22} color="#ffffff" />
          </Pressable>
        </SafeAreaView>
      </View>

      {/* ── Header: logo badge, name, @handle, school phrase ───────────── */}
      <View style={styles.header}>
        <View style={[styles.badgeRing, { borderColor: t.bg }]}>
          {logo !== undefined ? (
            <View style={[styles.badge, { backgroundColor: t.surface }]}>
              <Image
                source={logo}
                style={styles.badgeLogo}
                resizeMode="contain"
                accessibilityIgnoresInvertColors
              />
            </View>
          ) : (
            <Avatar name={name} seed={channelId || name} size={128} />
          )}
        </View>

        {logoH !== undefined ? (
          <Image
            source={logoH}
            style={styles.nameLockup}
            resizeMode="contain"
            accessible
            accessibilityRole="header"
            accessibilityLabel={name}
            accessibilityIgnoresInvertColors
          />
        ) : (
          <Text style={styles.name}>{name}</Text>
        )}
        {handleLine ? (
          <Text style={[styles.handle, { color: t.subtext }]}>{handleLine}</Text>
        ) : null}
        {schoolLine ? <Text style={styles.school}>{schoolLine}</Text> : null}

        {followable ? (
          <GoldButton
            label={isFollowing ? "Following" : "Follow"}
            variant={isFollowing ? "outline" : "solid"}
            onPress={toggleFollow}
            busy={busy}
            style={styles.followButton}
          />
        ) : null}
      </View>
      <View style={styles.gridLead} />
    </>
  );

  return (
    <View style={[styles.screen, { backgroundColor: t.bg }]}>
      <FlatList
        data={clips}
        keyExtractor={(item) => item.id}
        numColumns={2}
        columnWrapperStyle={styles.gridRow}
        contentContainerStyle={styles.content}
        ListHeaderComponent={header}
        onEndReachedThreshold={0.6}
        onEndReached={() => {
          if (list.hasNextPage && !list.isFetchingNextPage) void list.fetchNextPage();
        }}
        renderItem={({ item: clip }) => (
          /* Titles only: the channel is the page, so no meta line. */
          <Card
            title={clip.title}
            imageUrl={clip.thumbUrl}
            aspect="9:16"
            width={cardWidth}
            onPress={() => {
              track("card_tap", { contentId: clip.id, from: "channel" });
              router.push({
                pathname: "/video/[contentId]",
                params: { contentId: clip.id, channelId },
              });
            }}
          />
        )}
        ListEmptyComponent={
          list.isPending ? (
            <View style={styles.loading}>
              <ActivityIndicator size="large" color={t.accent} />
            </View>
          ) : list.isError ? (
            <ErrorState onRetry={() => void list.refetch()} />
          ) : (
            <EmptyState message="No clips on this channel yet. Check back soon." />
          )
        }
        ListFooterComponent={
          list.isFetchingNextPage ? (
            <ActivityIndicator size="small" color={t.accent} style={styles.footerSpin} />
          ) : null
        }
      />
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
  cover: {
    height: 140,
    justifyContent: "flex-start",
  },
  back: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: "rgba(0,0,0,0.42)",
    alignItems: "center",
    justifyContent: "center",
    marginLeft: tokens.spacing.md,
    marginTop: tokens.spacing.sm,
  },
  header: {
    alignItems: "center",
    paddingHorizontal: tokens.spacing.xl,
    // Half of the 128 badge sits on the cover band.
    marginTop: -64,
  },
  badgeRing: {
    borderWidth: 4,
    borderRadius: 68,
    overflow: "hidden",
  },
  badge: {
    width: 128,
    height: 128,
    borderRadius: 64,
    alignItems: "center",
    justifyContent: "center",
    padding: tokens.spacing.lg,
  },
  badgeLogo: {
    width: "100%",
    height: "100%",
  },
  // The chanh lockup at the site's phone height (clamp floor 64px), 3:1.
  nameLockup: {
    height: 64,
    width: 192,
    maxWidth: "100%",
    marginTop: tokens.spacing.sm,
  },
  // Text fallback for channels without a lockup (NIL TV, NIL STAR, legacy
  // shells): gold, tracked, uppercase like the site's channel heads; the
  // @handle and school line stay dim beneath it.
  name: {
    color: tokens.color.gold,
    fontFamily: tokens.font.extrabold,
    fontSize: 24,
    letterSpacing: 1,
    textAlign: "center",
    textTransform: "uppercase",
    marginTop: tokens.spacing.sm,
  },
  handle: {
    fontFamily: tokens.font.semibold,
    fontSize: 15,
    marginTop: 4,
    textAlign: "center",
  },
  // .chan-cap under the lockup: displayBold 13, tracked, uppercase, gold.
  school: {
    color: tokens.color.gold,
    fontFamily: tokens.font.displayBold,
    fontSize: tokens.text.meta,
    letterSpacing: 2,
    marginTop: 4,
    textAlign: "center",
    textTransform: "uppercase",
  },
  followButton: {
    alignSelf: "stretch",
    marginTop: tokens.spacing.lg,
  },
  gridLead: {
    height: tokens.spacing.lg,
  },
  gridRow: {
    gap: GRID_GAP,
    paddingHorizontal: tokens.spacing.lg,
    marginBottom: GRID_GAP,
  },
  loading: {
    paddingVertical: tokens.spacing.xl * 2,
    alignItems: "center",
  },
  footerSpin: {
    marginVertical: tokens.spacing.lg,
  },
});
