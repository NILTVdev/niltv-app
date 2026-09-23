/**
 * One channel's shelf on the Channels tab (mirroring the site's
 * per-channel rails under the channel wall): the chanh lockup as the head
 * with "See all" opening the channel screen, the "{School}'s Athletes"
 * caption, then the channel's newest clips as a strip of 9:16 cards, titles
 * only (the channel is the shelf). First page of GET /v1/content?channelId
 * only; the channel screen is where the list pages, and the strip ends in
 * a See more tile that opens it. Nothing renders on an
 * error or an empty list, a skeleton while the page is pending, so the tab
 * never shows a bare head.
 */
import type { ContentCard } from "@niltv/types";
import { FlatList, Image, Pressable, StyleSheet, Text, View } from "react-native";

import { useContentList } from "@/api/hooks";
import { channelDescriptor, channelLogoH } from "@/components/Brand";
import { Card } from "@/components/Card";
import { SeeMoreCard } from "@/components/Rail";
import { RailSkeleton } from "@/components/Skeleton";
import { tokens } from "@/theme/tokens";

/** The head lockup: chanh art is 3:1, 44 tall here (a rail head, not a page head). */
const LOCKUP_HEIGHT = 44;
const CARD_WIDTH = 150;

export function ChannelShelf({
  channelId,
  name,
  onSeeAll,
  onOpenClip,
}: {
  channelId: string;
  name: string;
  onSeeAll: () => void;
  onOpenClip: (clip: ContentCard) => void;
}) {
  const list = useContentList(channelId);
  const logoH = channelLogoH(channelId);
  const descriptor = channelDescriptor(channelId);

  if (list.isError) return null;
  if (list.isPending || !list.data) return <RailSkeleton cardWidth={CARD_WIDTH} />;
  const clips = list.data.pages[0]?.items ?? [];
  if (clips.length === 0) return null;

  return (
    <View style={styles.wrap}>
      <View style={styles.head}>
        {logoH !== undefined ? (
          <Image
            source={logoH}
            style={styles.lockup}
            resizeMode="contain"
            accessible
            accessibilityRole="header"
            accessibilityLabel={name}
            accessibilityIgnoresInvertColors
          />
        ) : (
          <Text numberOfLines={1} style={styles.name}>
            {name}
          </Text>
        )}
        <Pressable onPress={onSeeAll} accessibilityRole="link" accessibilityLabel={`See all ${name}`} hitSlop={8}>
          <Text style={styles.seeAll}>See all ›</Text>
        </Pressable>
      </View>
      {descriptor ? (
        <Text numberOfLines={1} style={styles.caption}>
          {descriptor}
        </Text>
      ) : null}
      <FlatList
        horizontal
        data={clips}
        keyExtractor={(clip) => clip.id}
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.strip}
        renderItem={({ item: clip }) => (
          <Card
            title={clip.title}
            imageUrl={clip.thumbUrl}
            aspect="9:16"
            width={CARD_WIDTH}
            onPress={() => onOpenClip(clip)}
          />
        )}
        ListFooterComponent={<SeeMoreCard title={name} aspect="9:16" width={CARD_WIDTH} onPress={onSeeAll} />}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    marginTop: tokens.spacing.xl,
  },
  head: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: tokens.spacing.lg,
  },
  lockup: {
    height: LOCKUP_HEIGHT,
    width: LOCKUP_HEIGHT * 3,
    marginLeft: -2,
  },
  // Text fallback for a channel without a lockup: the shelf-title voice.
  name: {
    color: tokens.color.gold,
    flexShrink: 1,
    fontFamily: tokens.font.displayBold,
    fontSize: 19,
    letterSpacing: 3,
    textTransform: "uppercase",
  },
  // .shelf-all: 13px, 600, dim (same as Rail).
  seeAll: {
    color: tokens.color.muted,
    fontFamily: tokens.font.semibold,
    fontSize: 13,
  },
  // .chan-cap, left aligned under the lockup.
  caption: {
    color: tokens.color.gold,
    fontFamily: tokens.font.displayBold,
    fontSize: tokens.text.meta,
    letterSpacing: 2,
    textTransform: "uppercase",
    paddingHorizontal: tokens.spacing.lg,
    marginTop: 2,
    marginBottom: tokens.spacing.md,
  },
  // Same strip metrics as Rail (lg gutters, 14 gap).
  strip: {
    paddingHorizontal: tokens.spacing.lg,
    gap: 14,
  },
});
