import type { AthleteChip } from "@niltv/types";
import { Ionicons } from "@expo/vector-icons";
import { Image } from "expo-image";
import { useRouter } from "expo-router";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { Avatar } from "@/components/Avatar";
import { athleteParams } from "@/lib/athleteRoute";
import { athleteVideoRoute } from "@/lib/athleteRecentVideos";
import { nilSchool } from "@/lib/format";
import { tokens } from "@/theme/tokens";
import { useTheme } from "@/theme/useTheme";

export function AthleteDirectoryCard({ athlete, discover = false, spotlight = false }: {
  athlete: AthleteChip; discover?: boolean; spotlight?: boolean;
}) {
  const t = useTheme();
  const router = useRouter();
  const video = discover ? athlete.latestVideo : undefined;
  const canOpen = athlete.profilePublished === true || Boolean(athlete.latestVideo);
  return (
    <View style={[styles.card, { backgroundColor: t.surface, borderColor: spotlight ? t.accent : t.line }]}>
      <Pressable
        disabled={!canOpen}
        accessibilityRole="link"
        accessibilityLabel={`${athlete.name}${canOpen ? ", view athlete" : ", videos coming soon"}`}
        accessibilityState={{ disabled: !canOpen }}
        onPress={() => router.push({ pathname: "/athlete/[id]", params: athleteParams(athlete) })}
        style={({ pressed }) => [styles.identity, !discover && styles.compact, { backgroundColor: pressed ? t.inset : t.surface }]}
      >
        <Avatar name={athlete.name} seed={athlete.id} url={athlete.avatarUrl} size={discover ? 52 : 44} />
        <View style={styles.copy}>
          {spotlight ? <Text style={[styles.eyebrow, { color: t.accent }]}>ATHLETE SPOTLIGHT</Text> : null}
          <Text style={[styles.name, { color: t.text }]}>{athlete.name}</Text>
          <Text style={[styles.meta, { color: t.subtext }]}>{[nilSchool(athlete.school), athlete.sport].filter(Boolean).join(" · ")}</Text>
          <Text style={[styles.action, { color: canOpen ? t.accent : t.subtext }]}>
            {athlete.profilePublished ? "View profile" : athlete.latestVideo ? "See videos" : "Videos coming soon"}
          </Text>
        </View>
        {!discover && canOpen ? <Ionicons name="chevron-forward" size={16} color={t.subtext} /> : null}
      </Pressable>
      {video ? (
        <Pressable
          accessibilityRole="link"
          accessibilityLabel={`Watch ${video.title} by ${athlete.name}`}
          onPress={() => router.push(athleteVideoRoute(video.id, athlete.id))}
          style={({ pressed }) => [styles.preview, spotlight && styles.spotlightPreview, { backgroundColor: t.inset, opacity: pressed ? 0.7 : 1 }]}
        >
          {video.thumbUrl ? <Image source={{ uri: video.thumbUrl }} contentFit="cover" recyclingKey={video.id} style={StyleSheet.absoluteFill} /> : null}
          <View pointerEvents="none" style={styles.videoOverlay}>
            <Text numberOfLines={2} style={styles.videoTitle}>{video.title}</Text>
            <View style={styles.play}>
              <Ionicons name="play" size={16} color="#fff" />
              <Text style={styles.playLabel}>Watch</Text>
            </View>
          </View>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { flexDirection: "row", borderWidth: 1, borderRadius: tokens.radius, overflow: "hidden" },
  identity: { flex: 1, minWidth: 0, padding: tokens.spacing.lg, gap: tokens.spacing.sm, justifyContent: "center" },
  compact: { flexDirection: "row", alignItems: "center", padding: tokens.spacing.md, gap: tokens.spacing.md },
  copy: { flex: 1, gap: 4, justifyContent: "center" },
  name: { fontFamily: tokens.font.semibold, fontSize: 16, lineHeight: 22 },
  meta: { fontFamily: tokens.font.regular, fontSize: 12, lineHeight: 18 },
  action: { fontFamily: tokens.font.semibold, fontSize: 11, lineHeight: 16, marginTop: 3 },
  eyebrow: { fontFamily: tokens.font.semibold, fontSize: 10, letterSpacing: 1, lineHeight: 16 },
  preview: { width: 112, minHeight: 176, justifyContent: "flex-end" },
  spotlightPreview: { width: 124, minHeight: 200 },
  videoOverlay: { padding: 8, gap: 6, backgroundColor: "rgba(0,0,0,0.72)" },
  videoTitle: { color: "#fff", fontFamily: tokens.font.semibold, fontSize: 11, lineHeight: 15 },
  play: { flexDirection: "row", alignItems: "center", alignSelf: "flex-start", gap: 4 },
  playLabel: { color: "#fff", fontFamily: tokens.font.semibold, fontSize: 11 },
});
