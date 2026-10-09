import { Ionicons } from "@expo/vector-icons";
import { Image } from "expo-image";
import { useRouter } from "expo-router";
import { Pressable, StyleSheet, View } from "react-native";

import { useAthleteRecentVideos } from "@/api/hooks";
import { tokens } from "@/theme/tokens";
import { useTheme } from "@/theme/useTheme";

/** Still thumbnails only: no video players or autoplay in the directory. */
export function AthleteRecentVideos({ athleteId, name }: { athleteId: string; name: string }) {
  const t = useTheme();
  const router = useRouter();
  const videos = useAthleteRecentVideos(athleteId);
  // A failed or revoked listing must never keep showing cached thumbnails.
  const clips = videos.isError ? [] : videos.data?.items.slice(0, 3) ?? [];

  return (
    <View style={styles.row}>
      {clips.map((clip) => (
        <Pressable
          key={clip.id}
          accessibilityRole="link"
          accessibilityLabel={`Watch ${clip.title} by ${name}`}
          onPress={() => router.push({
            pathname: "/video/[contentId]",
            params: { contentId: clip.id, profileId: athleteId },
          })}
          style={({ pressed }) => [styles.thumbnail, {
            backgroundColor: t.inset,
            opacity: pressed ? 0.65 : 1,
          }]}
        >
          {clip.thumbUrl ? (
            <Image source={{ uri: clip.thumbUrl }} style={StyleSheet.absoluteFill} contentFit="cover" recyclingKey={clip.id} />
          ) : null}
          <View pointerEvents="none" style={styles.play}>
            <Ionicons name="play" size={14} color={t.text} />
          </View>
        </Pressable>
      ))}
      {Array.from({ length: 3 - clips.length }, (_, index) => (
        <View key={`blank-${index}`} style={styles.blank} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { alignSelf: "stretch", flexDirection: "row", gap: tokens.spacing.xs, marginTop: tokens.spacing.sm },
  thumbnail: { flex: 1, aspectRatio: 9 / 16, minHeight: 64, borderRadius: 4, overflow: "hidden", justifyContent: "flex-end" },
  blank: { flex: 1, aspectRatio: 9 / 16, minHeight: 64 },
  play: { alignSelf: "flex-start", margin: 4, padding: 3, borderRadius: 12, backgroundColor: "rgba(0,0,0,0.5)" },
});