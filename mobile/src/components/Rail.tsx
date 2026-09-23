import { Ionicons } from "@expo/vector-icons";
import { FlatList, Image, Pressable, StyleSheet, Text, View } from "react-native";

import { Card, type CardProps } from "@/components/Card";
import { PressableScale } from "@/components/PressableScale";
import { tokens } from "@/theme/tokens";

export interface RailItem extends Omit<CardProps, "aspect" | "width"> {
  id: string;
}

export interface RailProps {
  title?: string;
  items: RailItem[];
  aspect?: CardProps["aspect"];
  cardWidth?: number;
  /**
   * Renders a "See all ›" link beside the title (demo's section header
   * link) and a See more tile after the last card that opens the
   * same target.
   */
  onSeeAll?: () => void;
  /**
   * A channel's horizontal lockup (chanh art, 3:1) rendered as the head in
   * place of the text title, the way the site heads its channel rails
   * (Home's channel rails carry the logos). `title` stays the
   * accessible name.
   */
  titleLogo?: number;
}

/**
 * The tile that ends a rail: a card-sized "See more" into the rail's
 * full list, so a five-card scroll finishes on a door, not a dead end. Same
 * frame as Card (aspect, width, corner) so the strip reads as one row of
 * equal tiles. ChannelShelf reuses it for its own strip.
 */
export function SeeMoreCard({
  title,
  aspect = "9:16",
  width = 180,
  onPress,
}: {
  /** the rail's name, for the accessible label */
  title?: string;
  aspect?: CardProps["aspect"];
  width?: number;
  onPress: () => void;
}) {
  const height = aspect === "9:16" ? (width * 16) / 9 : (width * 4) / 3;
  return (
    <PressableScale
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={title ? `See more ${title}` : "See more"}
      style={[styles.more, { width, height }]}
    >
      <View style={styles.moreCircle}>
        <Ionicons name="chevron-forward" size={24} color={tokens.color.ink} style={styles.moreIcon} />
      </View>
      <Text style={styles.moreLabel}>See more</Text>
    </PressableScale>
  );
}

/** Horizontal finger-scroll rail of Cards — no arrows (Brief §6, demo .rail). */
export function Rail({ title, items, aspect = "9:16", cardWidth = 180, onSeeAll, titleLogo }: RailProps) {
  return (
    <View style={styles.wrap}>
      {title ? (
        <View style={styles.titleRow}>
          {titleLogo !== undefined ? (
            <Image
              source={titleLogo}
              style={styles.lockup}
              resizeMode="contain"
              accessible
              accessibilityRole="header"
              accessibilityLabel={title}
              accessibilityIgnoresInvertColors
            />
          ) : (
            <Text numberOfLines={1} style={styles.title}>
              {title}
            </Text>
          )}
          {onSeeAll ? (
            <Pressable onPress={onSeeAll} accessibilityRole="link" accessibilityLabel={`See all ${title}`}>
              <Text style={styles.seeAll}>See all ›</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
      <FlatList
        horizontal
        data={items}
        keyExtractor={(item) => item.id}
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.content}
        renderItem={({ item }) => {
          const { id: _id, ...card } = item;
          return <Card {...card} aspect={aspect} width={cardWidth} />;
        }}
        // The footer is a cell of the same strip, so the content gap spaces
        // it from the last card like any other tile (no extra margin).
        ListFooterComponent={
          onSeeAll ? <SeeMoreCard title={title} aspect={aspect} width={cardWidth} onPress={onSeeAll} /> : null
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    marginTop: tokens.spacing.xl,
  },
  titleRow: {
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "space-between",
    marginBottom: tokens.spacing.md,
    paddingHorizontal: tokens.spacing.lg,
  },
  // The site's shelf title (cinema .shelf-title): Barlow Condensed
  // 700, 19px, .16em tracking (3px here), uppercase, gold. Every shelf on the
  // site is gold, so the colour lives here, not in the theme. flexShrink lets
  // the one-line title ellipsize instead of pushing See all off the row, the
  // site's own phone rule for .shelf-title.
  // chanh lockups are 3:1; 44 tall matches the Channels tab shelf heads.
  lockup: {
    height: 44,
    width: 132,
  },
  title: {
    color: tokens.color.gold,
    flexShrink: 1,
    fontFamily: tokens.font.displayBold,
    fontSize: 19,
    letterSpacing: 3,
    textTransform: "uppercase",
  },
  // .shelf-all: 13px, 600, dim.
  seeAll: {
    color: tokens.color.muted,
    fontFamily: tokens.font.semibold,
    fontSize: 13,
  },
  content: {
    paddingHorizontal: tokens.spacing.lg,
    gap: 14,
  },
  // See more tile: soft ground, 1px edge, Card's corner radius.
  more: {
    alignItems: "center",
    backgroundColor: tokens.color.soft,
    borderColor: tokens.color.line,
    borderRadius: tokens.radius - 2,
    borderWidth: 1,
    justifyContent: "center",
  },
  moreCircle: {
    alignItems: "center",
    backgroundColor: tokens.color.gold,
    borderRadius: 22,
    height: 44,
    justifyContent: "center",
    width: 44,
  },
  // The chevron glyph sits left of its box; nudge it to the optical centre.
  moreIcon: {
    marginLeft: 2,
  },
  moreLabel: {
    color: "#ffffff",
    fontFamily: tokens.font.bold,
    fontSize: 14,
    marginTop: tokens.spacing.sm,
  },
});
