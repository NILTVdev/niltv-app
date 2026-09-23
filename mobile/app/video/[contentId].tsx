/**
 * Vertical video feed (design §3.1, evolved to the Reels/TikTok pattern): a
 * full-screen pager. Opening a clip from Watch/Home (channelId param) or a
 * profile grid (profileId param) lands on that clip inside its list; swiping
 * up/down moves through the feed, and reaching the end of a channel feed pages
 * in more. The whole frame is always visible (contain on black), and playback
 * is tied to page visibility AND screen focus — only the active page of the
 * focused screen ever plays, so audio can never bleed across pages or under a
 * pushed profile screen.
 *
 * The page list is SNAPSHOTTED once it first settles: background refetches of
 * the source query can never shift or swap the clip under the viewer — later
 * items (pagination or destaled lists) only ever append.
 *
 * provider="hls" plays through expo-video; provider="embed" is the legacy
 * escape hatch (design §3.2/§12) — a themed link-out card, no WebView.
 */
import type { ContentCard, ContentDetailResponse } from "@niltv/types";
import { Ionicons } from "@expo/vector-icons";
import { useEvent, useEventListener } from "expo";
import { Image as PosterImage } from "expo-image";
import { LinearGradient } from "expo-linear-gradient";
import * as Linking from "expo-linking";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { VideoView, useVideoPlayer } from "expo-video";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Image,
  Pressable,
  Share,
  StyleSheet,
  Text,
  View,
  type ViewToken,
  useWindowDimensions,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import {
  useContentDetail,
  useContentList,
  useFollow,
  useLike,
  useMe,
  useProfile,
  useUnfollow,
  useUnlike,
} from "@/api/hooks";
import { requireAuth } from "@/auth/store";
import { AmbassadorBadge } from "@/components/AmbassadorBadge";
import { Avatar } from "@/components/Avatar";
import { channelIdForProfile, channelLogo } from "@/components/Brand";
import { formatCount, nilSchool } from "@/lib/format";
import { hapticImpact, hapticSelect } from "@/lib/haptics";
import { athleteParams } from "@/lib/athleteRoute";
import { goBack } from "@/lib/navigation";
import { track, useScreenView } from "@/telemetry";
import { createMilestoneGate } from "@/telemetry/milestones";
import { tokens } from "@/theme/tokens";

/** A page counts as active once it owns 60% of the viewport. */
const VIEWABILITY_CONFIG = { itemVisiblePercentThreshold: 60 };

/** Round translucent overlay button (demo .vround). */
function RoundButton({
  icon,
  label,
  onPress,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={6}
      style={({ pressed }) => [styles.round, pressed && { opacity: 0.7 }]}
    >
      <Ionicons name={icon} size={20} color="#ffffff" />
    </Pressable>
  );
}

/** Right-rail action: icon over a small count/label (TikTok rail column). */
function RailButton({
  icon,
  label,
  caption,
  tint = "#ffffff",
  selected,
  onPress,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  caption?: string;
  tint?: string;
  selected?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={selected !== undefined ? { selected } : undefined}
      hitSlop={8}
      style={({ pressed }) => [styles.rail, pressed && { opacity: 0.7 }]}
    >
      <Ionicons name={icon} size={30} color={tint} />
      {caption !== undefined ? <Text style={styles.railCaption}>{caption}</Text> : null}
    </Pressable>
  );
}

/** Themed link-out for provider="embed" — no WebView dependency, by design. */
function EmbedFallback({ detail }: { detail: ContentDetailResponse }) {
  return (
    <View style={styles.embedWrap}>
      <Ionicons name="open-outline" size={34} color={tokens.color.gold} />
      <Text style={styles.embedTitle}>Watch on the web</Text>
      <Text style={styles.embedCopy}>This clip plays on its original platform.</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Open video"
        onPress={() => {
          track("video_start", { contentId: detail.id, provider: "embed" });
          void Linking.openURL(detail.playbackUrl);
        }}
        style={({ pressed }) => [styles.embedButton, pressed && { backgroundColor: tokens.color.goldDeep }]}
      >
        <Text style={styles.embedButtonLabel}>Open video</Text>
      </Pressable>
    </View>
  );
}

/**
 * One full-screen page of the feed. The expo-video player starts with a null
 * source; the clip's detail (and its playbackUrl) loads once the page is near
 * the viewport (active ± 1), so swiping to a neighbour starts instantly while
 * far pages hold no player resources (virtualization unmounts them). Sources
 * are UNLOADED while the screen is blurred — a stack of feed → profile → feed
 * screens would otherwise hoard the device's few hardware video decoders.
 *
 * Milestones fire from player events, once per view (the set resets each time
 * the page becomes active again):
 *  - video_start             → first playingChange with isPlaying=true
 *  - video_progress_25/50/75 → timeUpdate (1s interval) crossing thresholds
 *  - video_complete          → playToEnd (or a timeUpdate reaching ≥99%)
 */
function FeedPage({
  card,
  active,
  near,
  focused,
  height,
}: {
  card: ContentCard;
  active: boolean;
  near: boolean;
  focused: boolean;
  height: number;
}) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const detail = useContentDetail(card.id, near);
  const me = useMe();
  const follow = useFollow();
  const unfollow = useUnfollow();
  const like = useLike();
  const unlike = useUnlike();

  const data = detail.data;
  const isEmbed = data !== undefined && data.provider !== "hls";
  const playbackUrl = data !== undefined && data.provider === "hls" ? data.playbackUrl : undefined;

  const player = useVideoPlayer(null, (p) => {
    p.loop = true;
    p.timeUpdateEventInterval = 1;
  });
  const { isPlaying } = useEvent(player, "playingChange", { isPlaying: player.playing });
  const { status } = useEvent(player, "statusChange", { status: player.status });

  const [posterHidden, setPosterHidden] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [playerFailed, setPlayerFailed] = useState(false);
  const [reloadNonce, setReloadNonce] = useState(0);

  // Source lifecycle: load while near on the FOCUSED screen; unload on blur so
  // covered feed screens release their decoders (the poster returns meanwhile).
  // pendingAutoplay makes the readyToPlay kick-off one-shot per load, so a
  // rebuffer can never override a manual pause.
  const loadedUrl = useRef<string | null>(null);
  const pendingAutoplay = useRef(false);
  // A load in flight: play() must not be issued against a source that is still
  // being swapped. On web that race rejects the underlying play() promise
  // ("The play() request was interrupted by a new load request") and the clip
  // never starts; readyToPlay below starts it instead.
  const loading = useRef(false);
  const loadGen = useRef(0);
  const mountedRef = useRef(true);
  useEffect(
    () => () => {
      mountedRef.current = false;
    },
    [],
  );
  useEffect(() => {
    if (focused && near && playbackUrl !== undefined) {
      if (loadedUrl.current === playbackUrl) return;
      loadedUrl.current = playbackUrl;
      pendingAutoplay.current = true;
      loading.current = true;
      const gen = ++loadGen.current;
      player
        .replaceAsync(playbackUrl)
        .then(() => {
          if (gen !== loadGen.current || !mountedRef.current) return;
          loading.current = false;
        })
        .catch(() => {
          // Scrolling abandons loads constantly — the page leaves the window
          // and unmounts, or a newer swap supersedes this one — and the
          // browser cancels the request. That rejection is NOT a playback
          // failure; only the current generation on a mounted page may report
          // one. Without this a healthy clip showed "Playback error" purely
          // because the user scrolled past it quickly.
          if (gen !== loadGen.current || !mountedRef.current) return;
          loading.current = false;
          loadedUrl.current = null;
          setPlayerFailed(true);
        });
    } else if (!focused && loadedUrl.current !== null) {
      loadGen.current += 1; // invalidate anything still in flight
      loadedUrl.current = null;
      pendingAutoplay.current = false;
      // Pause BEFORE unloading — tearing the source out from under a playing
      // element is the other half of the interrupted-play race.
      player.pause();
      player
        .replaceAsync(null)
        .then(() => setPosterHidden(false))
        .catch(() => {});
    }
  }, [focused, near, playbackUrl, player, reloadNonce]);

  // The ONLY autoplay rule: the active page of the focused screen plays,
  // everything else is paused. Manual taps aren't fought — this effect only
  // re-runs when visibility/focus changes.
  const shouldPlay = active && focused && playbackUrl !== undefined;
  const shouldPlayRef = useRef(shouldPlay);
  useEffect(() => {
    shouldPlayRef.current = shouldPlay;
    if (!shouldPlay) player.pause();
    else if (!loading.current) player.play();
    // else: the readyToPlay listener starts it once the swap resolves.
  }, [shouldPlay, player]);
  // replaceAsync resolves after the effect above — one-shot start on readiness.
  useEventListener(player, "statusChange", (payload) => {
    if (payload.status === "error") {
      // A cancelled request surfaces as an error status too, so only trust it
      // once a source has settled — mid-swap errors are the abort, not a fault.
      if (!loading.current && loadedUrl.current !== null) setPlayerFailed(true);
    } else if (payload.status === "readyToPlay" && pendingAutoplay.current) {
      pendingAutoplay.current = false;
      setPlayerFailed(false);
      if (shouldPlayRef.current && !player.playing) player.play();
    }
  });

  // Milestones count once per VIEW, and only from the page actually on screen.
  // Preloaded neighbours emit real player events (see milestones.ts) — without
  // the `active` argument those landed as starts on the wrong clip.
  const gate = useRef(createMilestoneGate());
  useEffect(() => {
    if (!active) gate.current.reset();
  }, [active]);
  const fire = (type: string, props: Record<string, unknown> = {}) => {
    if (!gate.current.allow(active, type)) return;
    track(type, { contentId: card.id, ...props });
  };
  useEventListener(player, "playingChange", (payload) => {
    if (payload.isPlaying) fire("video_start");
  });
  useEventListener(player, "timeUpdate", ({ currentTime }) => {
    const duration = player.duration > 0 ? player.duration : (data?.duration ?? card.duration ?? 0);
    if (duration <= 0) return;
    const progress = currentTime / duration;
    if (progress >= 0.25) fire("video_progress_25");
    if (progress >= 0.5) fire("video_progress_50");
    if (progress >= 0.75) fire("video_progress_75");
    if (progress >= 0.99) fire("video_complete");
  });
  useEventListener(player, "playToEnd", () => fire("video_complete"));

  const liked = me.data?.likes.includes(card.id) ?? false;
  const creatorId = data?.creator.id ?? card.creatorId;
  // Channel pseudo-profiles show their channel mark, not initials.
  const creatorChannelId = channelIdForProfile(creatorId);
  const creatorChannelArt = creatorChannelId ? channelLogo(creatorChannelId) : undefined;
  const isFollowing = me.data?.follows.includes(creatorId) ?? false;

  // Gated actions (design §3.3): guests see the auth sheet, then the tap resumes.
  const toggleLike = () =>
    requireAuth(() => {
      hapticImpact();
      if (liked) unlike.mutate(card.id);
      else like.mutate(card.id);
    });
  const toggleFollow = () =>
    requireAuth(() => {
      hapticImpact();
      if (isFollowing) unfollow.mutate(creatorId);
      else follow.mutate(creatorId);
    });
  const share = () => {
    // Placeholder share link — universal links (https://app.niltv.com/…) come later (design §3.2).
    void Share.share({ message: `${card.title}: https://app.niltv.com/video/${card.id}` });
  };
  const openCreator = () => {
    track("card_tap", { athleteId: creatorId, from: "video_creator" });
    // Channel creators land on the channel template; artless
    // channel pseudo-profiles still get there via the athlete route's bounce.
    if (creatorChannelId && creatorChannelArt !== undefined) {
      router.push({
        pathname: "/channel/[channelId]",
        params: { channelId: creatorChannelId, name: card.creatorName },
      });
    } else if (data) {
      router.push({ pathname: "/athlete/[id]", params: athleteParams(data.creator) });
    } else {
      router.push({ pathname: "/athlete/[id]", params: { id: creatorId, name: card.creatorName } });
    }
  };
  // A failed native load re-arms the source effect via the nonce.
  const retryPlayback = () => {
    setPlayerFailed(false);
    setReloadNonce((n) => n + 1);
  };

  const poster = card.thumbUrl ?? data?.thumbUrl;
  const description = data?.description ?? "";
  // Ingest truncates the title out of the same IG caption the description
  // holds, so equality never catches the duplicate — treat the description as
  // redundant when it just restates the title's opening.
  const titleStem = card.title.replace(/[.…\s]+$/u, "").toLowerCase();
  const redundantDescription =
    titleStem.length > 0 && description.trim().toLowerCase().startsWith(titleStem);
  // Tap-to-expand: ingest truncates the title out of the full IG
  // caption, so the expanded view shows the fullest text we hold.
  const fullText =
    redundantDescription && description.length > card.title.length ? description : card.title;

  return (
    <View style={[styles.page, { height }]}>
      {detail.isError ? (
        /* Per-page fetch failure: inline retry (the old screen's ErrorState equivalent). */
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Retry loading this clip"
          onPress={() => void detail.refetch()}
          style={styles.pageError}
        >
          <Ionicons name="cloud-offline-outline" size={34} color="#ffffff" />
          <Text style={styles.pageErrorTitle}>Couldn&apos;t load this clip</Text>
          <Text style={styles.pageErrorCopy}>Tap to retry</Text>
        </Pressable>
      ) : isEmbed && data ? (
        <EmbedFallback detail={data} />
      ) : (
        <>
          <VideoView
            player={player}
            nativeControls={false}
            contentFit="contain"
            surfaceType="textureView"
            onFirstFrameRender={() => setPosterHidden(true)}
            style={[StyleSheet.absoluteFill, styles.videoSurface]}
          />
          {/* Tap anywhere to toggle play/pause; an errored player retries instead. */}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={playerFailed ? "Retry playback" : isPlaying ? "Pause" : "Play"}
            onPress={() => {
              if (playerFailed) retryPlayback();
              else if (isPlaying) player.pause();
              else player.play();
            }}
            style={StyleSheet.absoluteFill}
          >
            {active && playerFailed ? (
              <View style={styles.playGlyphWrap}>
                <Ionicons name="refresh-circle" size={58} color="#ffffff" />
                <Text style={styles.pageErrorCopy}>Playback error. Tap to retry</Text>
              </View>
            ) : active && !isPlaying ? (
              <View style={styles.playGlyphWrap}>
                {status === "loading" || playbackUrl === undefined ? (
                  <ActivityIndicator size="large" color="#ffffff" />
                ) : (
                  <View style={styles.playGlyph}>
                    <Ionicons name="play" size={26} color="#1a1a1f" style={{ marginLeft: 3 }} />
                  </View>
                )}
              </View>
            ) : null}
          </Pressable>
          {/* Poster while the stream spins up (cleared on the first real frame). */}
          {!posterHidden && poster ? (
            <View style={[StyleSheet.absoluteFill, { pointerEvents: "none" }]}>
              <PosterImage
                source={{ uri: poster }}
                style={styles.poster}
                contentFit="contain"
                transition={tokens.motion.base}
                cachePolicy="memory-disk"
              />
            </View>
          ) : null}
        </>
      )}

      {/* Bottom scrim: creator, title, caption on the left — action rail right. */}
      <LinearGradient
        colors={["transparent", "rgba(0,0,0,0.28)", "rgba(0,0,0,0.86)"]}
        locations={[0, 0.4, 1]}
        style={[styles.overlayBottom, { paddingBottom: insets.bottom + tokens.spacing.lg }]}
      >
        <View style={styles.overlayText}>
          {data?.creator.school ? (
            <View style={styles.metaRow}>
              <Text numberOfLines={2} style={styles.school}>
                {nilSchool(data.creator.school)}
              </Text>
            </View>
          ) : null}
          <View style={styles.creatorRow}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`View ${card.creatorName}'s profile`}
              onPress={openCreator}
              style={({ pressed }) => [styles.creatorTap, pressed && { opacity: 0.75 }]}
            >
              {creatorChannelArt !== undefined ? (
                <View style={styles.creatorLogoBadge}>
                  <Image
                    source={creatorChannelArt}
                    style={styles.creatorLogoImg}
                    resizeMode="contain"
                    accessibilityIgnoresInvertColors
                  />
                </View>
              ) : (
                <Avatar
                  name={card.creatorName}
                  seed={creatorId}
                  url={data?.creator.avatarUrl}
                  size={30}
                />
              )}
              <Text numberOfLines={1} style={styles.creatorName}>
                {card.creatorName}
              </Text>
              {(data?.creator.isAmbassador ?? card.creatorIsAmbassador) ? (
                <AmbassadorBadge size="mini" />
              ) : null}
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={isFollowing ? "Unfollow" : "Follow"}
              onPress={toggleFollow}
              disabled={follow.isPending || unfollow.isPending}
              style={({ pressed }) => [
                styles.followButton,
                isFollowing
                  ? styles.followingButton
                  : { backgroundColor: pressed ? tokens.color.goldDeep : tokens.color.gold },
              ]}
            >
              <Text style={[styles.followLabel, isFollowing && styles.followingLabel]}>
                {isFollowing ? "Following" : "Follow"}
              </Text>
            </Pressable>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={expanded ? "Collapse the caption" : "Expand the caption"}
            onPress={() => setExpanded((e) => !e)}
          >
            {/* Expanded is capped, not unbounded — the overlay must never swallow the video. */}
            <Text numberOfLines={expanded ? 10 : 2} style={styles.title}>
              {expanded ? fullText : card.title}
            </Text>
          </Pressable>
          {description.length > 0 && !redundantDescription ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={expanded ? "Collapse description" : "Expand description"}
              onPress={() => setExpanded((e) => !e)}
            >
              {/* Expanded is capped, not unbounded — the overlay must never swallow the video. */}
              <Text numberOfLines={expanded ? 8 : 2} style={styles.description}>
                {description}
              </Text>
            </Pressable>
          ) : null}
        </View>
        <View style={styles.railColumn}>
          <RailButton
            icon={liked ? "heart" : "heart-outline"}
            label={liked ? "Unlike" : "Like"}
            selected={liked}
            tint={liked ? "#e0245e" : "#ffffff"}
            caption={data ? formatCount(data.likes) : undefined}
            onPress={toggleLike}
          />
          <RailButton icon="share-outline" label="Share" onPress={share} />
        </View>
      </LinearGradient>
    </View>
  );
}

/**
 * The pager over a SETTLED feed. Mounted only once the source list (or the
 * detail fallback) has resolved; the useState initializer freezes that list,
 * so background refetches can never shift or swap the clip under the viewer —
 * live items the seed hasn't seen (pagination, destaled lists) only APPEND.
 * Remounting (parent `key`) is the only way to reseed, which also guarantees
 * the viewed-index bookkeeping can never outlive its list.
 */
function SettledFeed({
  mode,
  liveItems,
  contentId,
  focused,
  onEndOfChannel,
}: {
  mode: "source" | "detail";
  liveItems: ContentCard[];
  contentId: string;
  focused: boolean;
  onEndOfChannel: () => void;
}) {
  const { height: pageHeight } = useWindowDimensions();
  const [seed] = useState(() => ({ mode, items: liveItems }));

  // Pure derivation — no state adjustment, no effects: seed order is frozen,
  // unseen live items (same mode only) join at the end.
  const seen = new Set(seed.items.map((c) => c.id));
  const appended = mode === seed.mode ? liveItems.filter((c) => !seen.has(c.id)) : [];
  const items = appended.length > 0 ? [...seed.items, ...appended] : seed.items;

  const foundIndex = seed.items.findIndex((c) => c.id === contentId);
  const startIndex = foundIndex >= 0 ? foundIndex : 0;
  const [viewedIndex, setViewedIndex] = useState<number | null>(null);
  const activeIndex = viewedIndex ?? startIndex;

  // Stable callback — FlatList forbids changing this across renders. Swipe
  // telemetry keys off a ref (not the state updater, which must stay pure).
  const lastViewedRef = useRef<number | null>(null);
  // VirtualizedList throws "Changing onViewableItemsChanged on the fly is not
  // supported" if this prop's identity ever changes, and useCallback is not a
  // strong enough guarantee here (this file is compiled by the React
  // Compiler). Built ONCE in a state initializer and delegating through a ref,
  // so the prop is frozen for the list's lifetime while the logic stays current.
  const handleViewable = ({ viewableItems }: { viewableItems: ViewToken[] }) => {
      const first = viewableItems.find((v) => v.isViewable && v.index !== null);
      if (first?.index == null) return;
      setViewedIndex(first.index);
      if (lastViewedRef.current !== null && lastViewedRef.current !== first.index && first.item) {
        // The page-settle tick (TikTok's snap feedback).
        hapticSelect();
        track("video_swipe", { contentId: (first.item as ContentCard).id, index: first.index });
      }
      lastViewedRef.current = first.index;
  };

  const viewableRef = useRef(handleViewable);
  useEffect(() => {
    viewableRef.current = handleViewable;
  });
  const [viewabilityPairs] = useState(() => [
    {
      viewabilityConfig: VIEWABILITY_CONFIG,
      onViewableItemsChanged: (info: { viewableItems: ViewToken[] }) => viewableRef.current(info),
    },
  ]);

  return (
    <FlatList
      data={items}
      keyExtractor={(item) => item.id}
      renderItem={({ item, index }) => (
        <FeedPage
          card={item}
          active={index === activeIndex}
          near={Math.abs(index - activeIndex) <= 1}
          focused={focused}
          height={pageHeight}
        />
      )}
      pagingEnabled
      showsVerticalScrollIndicator={false}
      getItemLayout={(_, index) => ({
        length: pageHeight,
        offset: pageHeight * index,
        index,
      })}
      initialScrollIndex={Math.min(startIndex, Math.max(items.length - 1, 0))}
      windowSize={3}
      initialNumToRender={1}
      maxToRenderPerBatch={1}
      viewabilityConfigCallbackPairs={viewabilityPairs}
      onEndReachedThreshold={2}
      onEndReached={mode === "source" ? onEndOfChannel : undefined}
    />
  );
}

export default function VideoFeedScreen() {
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{
    contentId: string;
    channelId?: string;
    profileId?: string;
  }>();
  const contentId = params.contentId ?? "";
  const channelId = params.channelId ?? "";
  const profileId = params.profileId ?? "";

  useScreenView("video", { contentId });

  // Focus drives pause-on-blur for every page and the status-bar override
  // (RN StatusBar instances stack — unmounting ours restores the root's).
  const [focused, setFocused] = useState(true);
  useFocusEffect(
    useCallback(() => {
      setFocused(true);
      return () => setFocused(false);
    }, []),
  );

  const channelList = useContentList(channelId);
  const profile = useProfile(profileId);
  const detail = useContentDetail(contentId);

  // Live resolution: the list the clip was opened from (channel or profile),
  // or a detail-derived feed (the clip + its related) for deep links.
  const liveItems = channelId
    ? channelList.data?.pages.flatMap((page) => page.items)
    : profileId
      ? profile.data?.content
      : undefined;
  const sourceSettled = channelId
    ? channelList.data !== undefined || channelList.isError
    : profileId
      ? profile.data !== undefined || profile.isError
      : true;
  const liveIndex = liveItems?.findIndex((c) => c.id === contentId) ?? -1;

  let liveMode: "source" | "detail" | "pending" = "pending";
  let liveFeed: ContentCard[] = [];
  if (liveItems !== undefined && liveIndex >= 0) {
    liveMode = "source";
    liveFeed = liveItems;
  } else if (sourceSettled && detail.data !== undefined) {
    const d = detail.data;
    liveMode = "detail";
    liveFeed = [
      {
        id: d.id,
        title: d.title,
        channelId: d.channelId,
        channelName: d.channelName,
        creatorId: d.creator.id,
        creatorName: d.creator.name,
        creatorIsAmbassador: d.creator.isAmbassador,
        thumbUrl: d.thumbUrl,
        duration: d.duration,
      },
      ...d.related.filter((c) => c.id !== d.id),
    ];
  }

  return (
    <View style={styles.screen}>
      {focused ? <StatusBar style="light" animated /> : null}
      {liveMode === "pending" ? (
        <View style={styles.pendingWrap}>
          {(channelId ? channelList.isError : profileId ? profile.isError : false) ||
          detail.isError ? (
            <>
              <Text style={styles.pendingTitle}>Can&apos;t reach NILTV</Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Retry"
                onPress={() => {
                  void detail.refetch();
                  if (channelId) void channelList.refetch();
                  if (profileId) void profile.refetch();
                }}
                style={({ pressed }) => [styles.retryButton, pressed && { backgroundColor: tokens.color.goldDeep }]}
              >
                <Text style={styles.retryLabel}>Retry</Text>
              </Pressable>
            </>
          ) : (
            <ActivityIndicator size="large" color="#ffffff" />
          )}
        </View>
      ) : (
        <SettledFeed
          mode={liveMode}
          liveItems={liveFeed}
          contentId={contentId}
          focused={focused}
          onEndOfChannel={() => {
            if (channelId && channelList.hasNextPage && !channelList.isFetchingNextPage) {
              void channelList.fetchNextPage();
            }
          }}
        />
      )}

      {/* Screen-level top scrim: back button, above every page. */}
      <LinearGradient
        colors={["rgba(0,0,0,0.45)", "transparent"]}
        style={[styles.overlayTop, { paddingTop: insets.top + tokens.spacing.sm }]}
      >
        <RoundButton icon="chevron-back" label="Back" onPress={() => goBack()} />
      </LinearGradient>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: "#000000",
  },
  page: {
    width: "100%",
    backgroundColor: "#000000",
    overflow: "hidden",
  },
  poster: {
    flex: 1,
  },
  // Web needs explicit dimensions; absoluteFill alone leaves the <video>
  // element at its intrinsic size inside the page.
  videoSurface: {
    width: "100%",
    height: "100%",
  },
  pendingWrap: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: tokens.spacing.md,
    padding: tokens.spacing.xl,
  },
  pendingTitle: {
    color: "#ffffff",
    fontFamily: tokens.font.extrabold,
    fontSize: 18,
  },
  retryButton: {
    backgroundColor: tokens.color.gold,
    borderRadius: 9,
    paddingVertical: 12,
    paddingHorizontal: 28,
  },
  retryLabel: {
    color: "#1a1a1f",
    fontFamily: tokens.font.bold,
    fontSize: 14,
  },
  pageError: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: "center",
    justifyContent: "center",
    gap: tokens.spacing.sm,
  },
  pageErrorTitle: {
    color: "#ffffff",
    fontFamily: tokens.font.extrabold,
    fontSize: 17,
  },
  pageErrorCopy: {
    color: "rgba(255,255,255,0.85)",
    fontFamily: tokens.font.regular,
    fontSize: 13,
  },
  round: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: "rgba(0,0,0,0.42)",
    alignItems: "center",
    justifyContent: "center",
  },
  playGlyphWrap: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: "center",
    justifyContent: "center",
    gap: tokens.spacing.sm,
    pointerEvents: "none",
  },
  playGlyph: {
    width: 58,
    height: 58,
    borderRadius: 29,
    backgroundColor: tokens.color.gold,
    alignItems: "center",
    justifyContent: "center",
  },
  overlayTop: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: tokens.spacing.md,
    paddingBottom: tokens.spacing.xl,
    pointerEvents: "box-none",
  },
  overlayBottom: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: "row",
    alignItems: "flex-end",
    gap: tokens.spacing.md,
    paddingTop: 48,
    paddingLeft: tokens.spacing.lg,
    paddingRight: tokens.spacing.md,
    pointerEvents: "box-none",
  },
  overlayText: {
    flex: 1,
    minWidth: 0,
    gap: 9,
    pointerEvents: "box-none",
  },
  metaRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
    pointerEvents: "none",
  },
  creatorLogoBadge: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: "rgba(255,255,255,0.14)",
    alignItems: "center",
    justifyContent: "center",
    padding: 3,
  },
  creatorLogoImg: {
    width: "100%",
    height: "100%",
  },
  school: {
    color: "#ffffff",
    fontFamily: tokens.font.bold,
    fontSize: 12,
    opacity: 0.92,
    flexShrink: 1,
  },
  creatorRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  creatorTap: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    flexShrink: 1,
  },
  creatorName: {
    color: "#ffffff",
    fontFamily: tokens.font.extrabold,
    fontSize: 15,
    flexShrink: 1,
  },
  followButton: {
    borderRadius: 8,
    paddingVertical: 7,
    paddingHorizontal: 12,
  },
  followingButton: {
    backgroundColor: "transparent",
    borderWidth: 1.5,
    borderColor: "#ffffff",
  },
  followLabel: {
    color: "#1a1a1f",
    fontFamily: tokens.font.bold,
    fontSize: 12,
  },
  followingLabel: {
    color: "#ffffff",
  },
  title: {
    color: "#ffffff",
    fontFamily: tokens.font.extrabold,
    fontSize: 17,
    letterSpacing: 0.2,
    lineHeight: 22,
  },
  description: {
    color: "rgba(255,255,255,0.88)",
    fontFamily: tokens.font.regular,
    fontSize: 13,
    lineHeight: 18,
  },
  railColumn: {
    alignItems: "center",
    gap: tokens.spacing.lg,
    paddingBottom: 2,
    pointerEvents: "box-none",
  },
  rail: {
    alignItems: "center",
    gap: 3,
  },
  railCaption: {
    color: "#ffffff",
    fontFamily: tokens.font.bold,
    fontSize: 11,
  },
  embedWrap: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: "center",
    justifyContent: "center",
    gap: tokens.spacing.sm,
    backgroundColor: "rgba(22,22,26,0.55)",
    padding: tokens.spacing.xl,
  },
  embedTitle: {
    color: "#ffffff",
    fontFamily: tokens.font.extrabold,
    fontSize: 19,
  },
  embedCopy: {
    color: "rgba(255,255,255,0.8)",
    fontFamily: tokens.font.regular,
    fontSize: 13,
    textAlign: "center",
  },
  embedButton: {
    marginTop: tokens.spacing.sm,
    backgroundColor: tokens.color.gold,
    borderRadius: 9,
    paddingVertical: 12,
    paddingHorizontal: 22,
  },
  embedButtonLabel: {
    color: "#1a1a1f",
    fontFamily: tokens.font.bold,
    fontSize: 14,
  },
});
