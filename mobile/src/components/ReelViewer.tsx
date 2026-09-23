/**
 * Full-screen vertical reel viewer (TikTok's grid → viewer flow): opens on
 * the tapped item, swipe up/down moves through the list, X or system back
 * returns. Reels render `contain` on black — never cropped out of frame.
 * Shared by the season recap (champion + Top 20) and event showcases.
 */
import { Ionicons } from "@expo/vector-icons";
import { Image } from "expo-image";
import { LinearGradient } from "expo-linear-gradient";
import { VideoView, useVideoPlayer } from "expo-video";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { PressableScale } from "@/components/PressableScale";
import { hapticSelect } from "@/lib/haptics";
import { tokens } from "@/theme/tokens";

export interface ReelItem {
  name: string;
  meta?: string;
  photoUrl?: string;
  videoUrl?: string;
}

/** One page: reel letterboxed on black, tap toggles pause. */
function ViewerPage({
  item,
  height,
  active,
  near,
}: {
  item: ReelItem;
  height: number;
  active: boolean;
  near: boolean;
}) {
  // `ready` flips async once the source is loaded (poster shows until then);
  // the load latch is a ref so the effect never sets state synchronously.
  const [ready, setReady] = useState(false);
  const loadRef = useRef(false);
  const activeRef = useRef(active);
  const player = useVideoPlayer(null, (p) => {
    p.loop = true;
  });
  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  // Load when the page is on-screen or adjacent; play only while active.
  useEffect(() => {
    if (!near || loadRef.current || !item.videoUrl) return;
    loadRef.current = true;
    player
      .replaceAsync(item.videoUrl)
      .then(() => {
        setReady(true);
        if (activeRef.current) player.play();
      })
      .catch(() => {
        loadRef.current = false;
      });
  }, [near, item.videoUrl, player]);
  useEffect(() => {
    if (active && ready) player.play();
    else player.pause();
  }, [active, ready, player]);

  return (
    <Pressable
      onPress={() => {
        if (!ready) return;
        if (player.playing) player.pause();
        else player.play();
      }}
      accessibilityLabel={item.name}
      style={[styles.page, { height }]}
    >
      {ready ? (
        <VideoView
          player={player}
          nativeControls={false}
          contentFit="contain"
          surfaceType="textureView"
          // Explicit size on top of absoluteFill: the web <video> element
          // otherwise renders at intrinsic size in the corner.
          style={[StyleSheet.absoluteFill, styles.videoSurface]}
        />
      ) : item.photoUrl ? (
        <Image
          source={{ uri: item.photoUrl }}
          style={StyleSheet.absoluteFill}
          contentFit="contain"
          transition={tokens.motion.base}
          cachePolicy="memory-disk"
        />
      ) : null}
      <LinearGradient
        colors={["transparent", "rgba(0,0,0,0.72)"]}
        style={styles.scrim}
      />
      <View style={styles.meta}>
        <Text style={styles.name}>{item.name}</Text>
        {item.meta ? <Text style={styles.sub}>{item.meta}</Text> : null}
      </View>
    </Pressable>
  );
}

export function ReelViewer({
  items,
  startIndex,
  onClose,
}: {
  items: ReelItem[];
  startIndex: number;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const [activeIndex, setActiveIndex] = useState(startIndex);
  const lastIndex = useRef(startIndex);
  const onViewableItemsChanged = useCallback(
    ({ viewableItems }: { viewableItems: { isViewable: boolean; index: number | null }[] }) => {
      const first = viewableItems.find((v) => v.isViewable && v.index !== null);
      if (first?.index == null) return;
      setActiveIndex(first.index);
      if (lastIndex.current !== first.index) hapticSelect();
      lastIndex.current = first.index;
    },
    [],
  );

  return (
    <Modal visible animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <View style={styles.root}>
        <FlatList
          data={items}
          keyExtractor={(item) => item.name}
          renderItem={({ item, index }) => (
            <ViewerPage
              item={item}
              height={height}
              active={index === activeIndex}
              near={Math.abs(index - activeIndex) <= 1}
            />
          )}
          pagingEnabled
          showsVerticalScrollIndicator={false}
          initialScrollIndex={startIndex}
          getItemLayout={(_, index) => ({ length: height, offset: height * index, index })}
          initialNumToRender={1}
          maxToRenderPerBatch={2}
          windowSize={3}
          onViewableItemsChanged={onViewableItemsChanged}
          viewabilityConfig={{ itemVisiblePercentThreshold: 60 }}
        />
        <PressableScale
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Close"
          hitSlop={8}
          style={[styles.close, { top: insets.top + tokens.spacing.sm }]}
        >
          <Ionicons name="close" size={22} color="#ffffff" />
        </PressableScale>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: "#000000",
  },
  page: {
    width: "100%",
    backgroundColor: "#000000",
  },
  videoSurface: {
    width: "100%",
    height: "100%",
  },
  scrim: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    height: 140,
    pointerEvents: "none",
  },
  meta: {
    position: "absolute",
    left: tokens.spacing.lg,
    right: tokens.spacing.lg,
    bottom: tokens.spacing.xl,
    pointerEvents: "none",
  },
  name: {
    color: "#ffffff",
    fontFamily: tokens.font.extrabold,
    fontSize: tokens.text.title,
  },
  sub: {
    color: "rgba(255,255,255,0.8)",
    fontFamily: tokens.font.regular,
    fontSize: tokens.text.meta,
    marginTop: 2,
  },
  close: {
    position: "absolute",
    right: tokens.spacing.lg,
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: "rgba(6,6,8,0.5)",
    alignItems: "center",
    justifyContent: "center",
  },
});
