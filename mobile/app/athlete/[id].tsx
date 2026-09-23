/**
 * Athlete profile (demo screen-athlete, design §3.1): cover band + header from
 * GET /v1/profiles/{id}, stats row, and Content | About segments. While the
 * profile loads, the header paints from the route params the tapping surface
 * passed (athleteParams) — graceful fallback, no blank screen.
 */
import type { ContentCard } from "@niltv/types";
import { Ionicons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import * as Linking from "expo-linking";
import { Redirect, useLocalSearchParams, useRouter } from "expo-router";
import { useState } from "react";
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

import {
  useChannels,
  useCreatorContentList,
  useFollow,
  useMe,
  useProfile,
  useUnfollow,
} from "@/api/hooks";
import { requireAuth } from "@/auth/store";
import { AmbassadorBadge } from "@/components/AmbassadorBadge";
import { Avatar } from "@/components/Avatar";
import { channelIdForProfile, channelLogo } from "@/components/Brand";
import { Card, thumbGradient } from "@/components/Card";
import { EmptyState, ErrorState } from "@/components/ScreenState";
import { GoldButton } from "@/components/GoldButton";
import { SegmentedControl } from "@/components/SegmentedControl";
import { formatCount, nilSchool } from "@/lib/format";
import { hapticImpact } from "@/lib/haptics";
import { goBack } from "@/lib/navigation";
import { track, useScreenView } from "@/telemetry";
import { tokens } from "@/theme/tokens";
import { useTheme } from "@/theme/useTheme";

const GRID_GAP = tokens.spacing.md;
const SEGMENTS = ["Content", "About"];

function socialIcon(platform: string): keyof typeof Ionicons.glyphMap {
  switch (platform.toLowerCase()) {
    case "instagram":
      return "logo-instagram";
    case "tiktok":
      return "logo-tiktok";
    case "x":
    case "twitter":
      return "logo-twitter";
    case "youtube":
      return "logo-youtube";
    case "twitch":
      return "logo-twitch";
    default:
      return "globe-outline";
  }
}

function Stat({ value, label }: { value: number; label: string }) {
  const t = useTheme();
  return (
    <View style={styles.stat}>
      <Text style={[styles.statValue, { color: t.text }]}>{formatCount(value)}</Text>
      <Text style={[styles.statLabel, { color: t.subtext }]}>{label}</Text>
    </View>
  );
}

export default function AthleteScreen() {
  const t = useTheme();
  const router = useRouter();
  const { width } = useWindowDimensions();
  const params = useLocalSearchParams<{
    id: string;
    name?: string;
    school?: string;
    sport?: string;
    isAmbassador?: string;
    rank?: string;
  }>();

  const id = params.id ?? "";
  const profile = useProfile(id);
  const data = profile.data;
  useScreenView("athlete", { athleteId: id });

  // This route serves PEOPLE (channels live on /channel, on the same
  // layout family; ambassadors join here later). A p-{account} id
  // that maps to a channel — by bundled art instantly, or the channels list
  // once it resolves — bounces to the channel template below, after the hooks.
  const profileChannelId = channelIdForProfile(id);
  const channels = useChannels();
  const isChannelProfile =
    profileChannelId !== undefined &&
    (channelLogo(profileChannelId) !== undefined ||
      channels.data?.channels.some((c) => c.id === profileChannelId) === true);

  // Fetched profile wins; route params keep the header painted while it loads.
  const name = data?.name ?? params.name ?? "Athlete";
  const school = data?.school ?? params.school ?? "";
  const sport = data?.sport ?? params.sport ?? "";
  const isAmbassador =
    data?.statuses.includes("ambassador") ??
    (params.isAmbassador === "1" || params.isAmbassador === "true");
  const rank =
    data?.ambassadorRank ??
    (params.rank && params.rank.length > 0 ? Number(params.rank) : undefined);
  const handle = data?.handle;

  const [segment, setSegment] = useState(SEGMENTS[0] ?? "Content");

  const me = useMe();
  const follow = useFollow();
  const unfollow = useUnfollow();
  const isFollowing = me.data?.follows.includes(id) ?? false;
  const busy = follow.isPending || unfollow.isPending;

  // Gated action (design §3.3): guests get the auth sheet, then the follow runs.
  const toggleFollow = () =>
    requireAuth(() => {
      hapticImpact();
      if (isFollowing) unfollow.mutate(id);
      else follow.mutate(id);
    });

  // floor() so two cards + gap can never exceed the row by a subpixel.
  const cardWidth = Math.floor((width - tokens.spacing.lg * 2 - GRID_GAP) / 2);
  const schoolLine = nilSchool(school);
  // Two meta lines under the name: the @handle, then the school
  // phrase with the sport.
  const handleLine = handle ? (handle.startsWith("@") ? handle : `@${handle}`) : "";
  const detailLine = [schoolLine, sport].filter(Boolean).join(" · ");

  // Infinite content grid: the profile endpoint returns only the
  // first dozen clips, so the grid pages through /v1/content?athleteId. If
  // the deployed API predates that param (400, no retry), the profile's own
  // capped list stands in.
  const feed = useCreatorContentList(isChannelProfile ? "" : id);
  const pagedClips = feed.data?.pages.flatMap((page) => page.items);
  const clips: ContentCard[] = pagedClips ?? data?.content ?? [];
  const showGrid = segment === "Content";

  if (isChannelProfile && profileChannelId) {
    return (
      <Redirect
        href={{
          pathname: "/channel/[channelId]",
          params: { channelId: profileChannelId, name },
        }}
      />
    );
  }

  const header = (
    <>
      {/* ── Cover band ─────────────────────────────────────────────────── */}
      <View style={styles.cover}>
        {data?.coverUrl ? (
          <Image
            source={{ uri: data.coverUrl }}
            style={StyleSheet.absoluteFill}
            resizeMode="cover"
            accessibilityIgnoresInvertColors
          />
        ) : (
          <LinearGradient
            colors={thumbGradient(id || name)}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={StyleSheet.absoluteFill}
          />
        )}
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

      {/* ── Header ─────────────────────────────────────────────────────── */}
      <View style={styles.header}>
        <View style={[styles.avatarRing, { borderColor: t.bg }]}>
          <Avatar name={name} seed={id || name} url={data?.avatarUrl} size={96} />
        </View>

        <View style={styles.nameRow}>
          <Text style={[styles.name, { color: t.text }]}>{name}</Text>
          {isAmbassador ? (
            <AmbassadorBadge label={rank ? `Ambassador · #${rank}` : "Ambassador"} />
          ) : null}
        </View>
        {handleLine ? (
          <Text style={[styles.metaHandle, { color: t.subtext }]}>{handleLine}</Text>
        ) : null}
        {detailLine ? (
          <Text style={[styles.meta, { color: t.subtext }]}>{detailLine}</Text>
        ) : null}

        {data ? (
          <View style={[styles.statsRow, { borderColor: t.line }]}>
            <Stat value={data.stats.followers} label="Followers" />
            <Stat value={data.stats.views} label="Views" />
            <Stat value={data.stats.nilstarVotes} label="NIL STAR votes" />
          </View>
        ) : null}

        <GoldButton
          label={isFollowing ? "Following" : "Follow"}
          variant={isFollowing ? "outline" : "solid"}
          onPress={toggleFollow}
          busy={busy}
          style={styles.followButton}
        />
      </View>

      {!data ? (
        profile.isError ? (
          <ErrorState onRetry={() => void profile.refetch()} />
        ) : (
          <View style={styles.loading}>
            <ActivityIndicator size="large" color={t.accent} />
          </View>
        )
      ) : (
        <View style={styles.body}>
          <SegmentedControl options={SEGMENTS} value={segment} onChange={setSegment} />
        </View>
      )}
      <View style={styles.gridLead} />
    </>
  );

  const aboutBlock =
    data && !showGrid ? (
      <View style={styles.aboutFooter}>
        {data.bio ? <Text style={[styles.bio, { color: t.text }]}>{data.bio}</Text> : null}

        {data.brands.length > 0 ? (
          <>
            <Text style={[styles.aboutSection, { color: t.text }]}>Brands worked with</Text>
            <View style={styles.chipWrap}>
              {data.brands.map((brand) => (
                <View key={brand} style={[styles.brandChip, { backgroundColor: t.inset }]}>
                  <Text style={[styles.brandChipLabel, { color: t.subtext }]}>{brand}</Text>
                </View>
              ))}
            </View>
          </>
        ) : null}

        {data.socials.length > 0 ? (
          <>
            <Text style={[styles.aboutSection, { color: t.text }]}>Socials</Text>
            <View style={styles.chipWrap}>
              {data.socials.map((social) => (
                <Pressable
                  key={`${social.platform}-${social.url}`}
                  accessibilityRole="link"
                  accessibilityLabel={social.platform}
                  onPress={() => void Linking.openURL(social.url)}
                  style={({ pressed }) => [
                    styles.socialChip,
                    { borderColor: t.line, opacity: pressed ? 0.7 : 1 },
                  ]}
                >
                  <Ionicons name={socialIcon(social.platform)} size={16} color={t.accent} />
                  <Text style={[styles.socialLabel, { color: t.text }]}>
                    {social.platform}
                  </Text>
                </Pressable>
              ))}
            </View>
          </>
        ) : null}

        {!data.bio && data.brands.length === 0 && data.socials.length === 0 ? (
          <EmptyState message="Nothing here yet." />
        ) : null}
      </View>
    ) : null;

  return (
    <View style={[styles.screen, { backgroundColor: t.bg }]}>
      <FlatList
        data={data && showGrid ? clips : []}
        keyExtractor={(item) => item.id}
        numColumns={2}
        columnWrapperStyle={styles.gridRow}
        contentContainerStyle={styles.content}
        ListHeaderComponent={header}
        onEndReachedThreshold={0.6}
        onEndReached={() => {
          if (showGrid && feed.hasNextPage && !feed.isFetchingNextPage) void feed.fetchNextPage();
        }}
        renderItem={({ item: clip }) => (
          <Card
            title={clip.title}
            meta={clip.channelName}
            imageUrl={clip.thumbUrl}
            aspect="9:16"
            width={cardWidth}
            onPress={() => {
              track("card_tap", { contentId: clip.id, from: "athlete_content" });
              // profileId gives the feed its swipe context (this creator's clips).
              router.push({
                pathname: "/video/[contentId]",
                params: { contentId: clip.id, profileId: id },
              });
            }}
          />
        )}
        ListEmptyComponent={
          data && showGrid ? (
            <EmptyState message="No clips yet. Their first drop lands here." />
          ) : null
        }
        ListFooterComponent={
          showGrid && feed.isFetchingNextPage ? (
            <ActivityIndicator size="small" color={t.accent} style={styles.footerSpin} />
          ) : (
            aboutBlock
          )
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
    marginTop: -48,
  },
  avatarRing: {
    borderWidth: 4,
    borderRadius: 52,
    overflow: "hidden",
  },
  nameRow: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    justifyContent: "center",
    gap: 8,
    marginTop: tokens.spacing.sm,
  },
  name: {
    fontFamily: tokens.font.extrabold,
    fontSize: 24,
    textAlign: "center",
  },
  metaHandle: {
    fontFamily: tokens.font.semibold,
    fontSize: 15,
    marginTop: 4,
    textAlign: "center",
  },
  meta: {
    fontFamily: tokens.font.regular,
    fontSize: 14,
    marginTop: 2,
    textAlign: "center",
  },
  statsRow: {
    flexDirection: "row",
    alignSelf: "stretch",
    justifyContent: "space-evenly",
    borderTopWidth: 1,
    borderBottomWidth: 1,
    paddingVertical: tokens.spacing.md,
    marginTop: tokens.spacing.lg,
  },
  stat: {
    alignItems: "center",
    minWidth: 84,
  },
  statValue: {
    fontFamily: tokens.font.extrabold,
    fontSize: 18,
  },
  statLabel: {
    fontFamily: tokens.font.semibold,
    fontSize: 11,
    marginTop: 1,
  },
  followButton: {
    alignSelf: "stretch",
    marginTop: tokens.spacing.lg,
  },
  loading: {
    paddingVertical: tokens.spacing.xl * 2,
    alignItems: "center",
  },
  body: {
    paddingHorizontal: tokens.spacing.lg,
    marginTop: tokens.spacing.xl,
  },
  gridRow: {
    gap: GRID_GAP,
    paddingHorizontal: tokens.spacing.lg,
    marginBottom: GRID_GAP,
  },
  gridLead: {
    height: tokens.spacing.lg,
  },
  footerSpin: {
    marginVertical: tokens.spacing.lg,
  },
  aboutFooter: {
    paddingHorizontal: tokens.spacing.lg,
    marginTop: tokens.spacing.sm,
  },
  bio: {
    fontFamily: tokens.font.regular,
    fontSize: 15,
    lineHeight: 22,
  },
  aboutSection: {
    fontFamily: tokens.font.extrabold,
    fontSize: 15,
    marginTop: tokens.spacing.xl,
    marginBottom: tokens.spacing.md,
  },
  chipWrap: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: tokens.spacing.sm,
  },
  brandChip: {
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 8,
  },
  brandChipLabel: {
    fontFamily: tokens.font.bold,
    fontSize: 12,
  },
  socialChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderWidth: 1,
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  socialLabel: {
    fontFamily: tokens.font.bold,
    fontSize: 13,
    textTransform: "capitalize",
  },
});
