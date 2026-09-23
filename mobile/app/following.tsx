/**
 * Following management: every athlete/creator the
 * signed-in account follows, with unfollow and tap-through to their profile.
 * Names resolve from the profiles directory; ids without a directory entry
 * (e.g. a creator not yet listed) still render and can be unfollowed.
 */
import type { AthleteChip } from "@niltv/types";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { FlatList, Image, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { useChannels, useMe, useProfilesAll, useUnfollow } from "@/api/hooks";
import { Avatar } from "@/components/Avatar";
import { channelIdForProfile, channelLogo, channelSchool } from "@/components/Brand";
import { EmptyState, ErrorState, LoadingState } from "@/components/ScreenState";
import { schoolMeta } from "@/lib/format";
import { athleteParams } from "@/lib/athleteRoute";
import { goBack } from "@/lib/navigation";
import { track, useScreenView } from "@/telemetry";
import { tokens } from "@/theme/tokens";
import { useTheme } from "@/theme/useTheme";

export default function FollowingScreen() {
  const t = useTheme();
  const router = useRouter();
  useScreenView("following");

  const me = useMe();
  const directory = useProfilesAll();
  const channels = useChannels();
  const unfollow = useUnfollow();

  const follows = me.data?.follows ?? [];
  const byId = new Map((directory.data?.profiles ?? []).map((p) => [p.id, p]));
  const channelById = new Map((channels.data?.channels ?? []).map((c) => [c.id, c]));
  // Channel pseudo-profiles (p-{account}) aren't in the athlete directory —
  // resolve them from the channels list + bundled art so a followed channel
  // reads as its name + logo, never a raw id.
  const rows = follows.map((id): AthleteChip & { logo?: number } => {
    const channelId = channelIdForProfile(id);
    const channel = channelId ? channelById.get(channelId) : undefined;
    if (channelId && channel) {
      return {
        id,
        name: channel.name,
        school: channelSchool(channelId) ?? "",
        sport: "",
        isAmbassador: false,
        logo: channelLogo(channelId),
      };
    }
    return (
      byId.get(id) ?? ({ id, name: id, school: "", sport: "", isAmbassador: false } as AthleteChip)
    );
  });

  return (
    <SafeAreaView edges={["top"]} style={[styles.screen, { backgroundColor: t.bg }]}>
      <View style={styles.header}>
        <Pressable onPress={() => goBack()} accessibilityRole="button" accessibilityLabel="Back" hitSlop={8}>
          <Ionicons name="chevron-back" size={26} color={t.text} />
        </Pressable>
        <Text style={[styles.heading, { color: t.text }]}>Following</Text>
      </View>

      <FlatList
        data={rows}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.content}
        renderItem={({ item }) => (
          <View style={[styles.row, { borderColor: t.line, backgroundColor: t.surface }]}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`View ${item.name}'s profile`}
              onPress={() => {
                track("card_tap", { athleteId: item.id, from: "following" });
                const channelId = item.logo !== undefined ? channelIdForProfile(item.id) : undefined;
                if (channelId) {
                  router.push({
                    pathname: "/channel/[channelId]",
                    params: { channelId, name: item.name },
                  });
                  return;
                }
                router.push({ pathname: "/athlete/[id]", params: athleteParams(item) });
              }}
              style={({ pressed }) => [styles.rowTap, pressed && { opacity: 0.8 }]}
            >
              {item.logo !== undefined ? (
                <View style={styles.logoBadge}>
                  <Image source={item.logo} style={styles.logoImg} resizeMode="contain" accessibilityIgnoresInvertColors />
                </View>
              ) : (
                <Avatar name={item.name} seed={item.id} url={item.avatarUrl} size={44} />
              )}
              <View style={styles.rowInfo}>
                <Text numberOfLines={1} style={[styles.rowName, { color: t.text }]}>
                  {item.name}
                </Text>
                {item.school || item.sport ? (
                  <Text numberOfLines={2} style={[styles.rowMeta, { color: t.subtext }]}>
                    {schoolMeta(item.school, item.sport)}
                  </Text>
                ) : null}
              </View>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Unfollow ${item.name}`}
              disabled={unfollow.isPending}
              onPress={() => unfollow.mutate(item.id)}
              style={({ pressed }) => [
                styles.unfollow,
                { borderColor: t.accent, opacity: pressed || unfollow.isPending ? 0.6 : 1 },
              ]}
            >
              <Text style={[styles.unfollowLabel, { color: t.accent }]}>Following</Text>
            </Pressable>
          </View>
        )}
        ListEmptyComponent={
          me.isPending || directory.isPending ? (
            <LoadingState />
          ) : me.isError ? (
            <ErrorState onRetry={() => void me.refetch()} />
          ) : (
            <EmptyState message="You're not following any channels yet. Find them on any clip or channel page." />
          )
        }
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: tokens.spacing.sm,
    paddingHorizontal: tokens.spacing.lg,
    paddingVertical: tokens.spacing.md,
  },
  heading: {
    fontFamily: tokens.font.extrabold,
    fontSize: 22,
  },
  content: {
    paddingHorizontal: tokens.spacing.lg,
    paddingBottom: tokens.spacing.xl * 2,
    flexGrow: 1,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: tokens.spacing.md,
    borderWidth: 1,
    borderRadius: tokens.radius,
    padding: tokens.spacing.md,
    marginBottom: 10,
  },
  rowTap: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: tokens.spacing.md,
    minWidth: 0,
  },
  rowInfo: {
    flex: 1,
    minWidth: 0,
  },
  rowName: {
    fontFamily: tokens.font.bold,
    fontSize: 15,
  },
  rowMeta: {
    fontFamily: tokens.font.regular,
    fontSize: 12,
    marginTop: 2,
  },
  unfollow: {
    borderWidth: 1.5,
    borderRadius: 8,
    paddingVertical: 7,
    paddingHorizontal: 12,
  },
  unfollowLabel: {
    fontFamily: tokens.font.bold,
    fontSize: 12,
  },
  logoBadge: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "rgba(255,255,255,0.10)",
    alignItems: "center",
    justifyContent: "center",
    padding: 5,
  },
  logoImg: {
    width: "100%",
    height: "100%",
  },
});
