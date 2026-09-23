/**
 * Profiles directory (demo screen-profiles, design §3.1) — built but DARK:
 * renders a themed "Coming soon" until flags.ambassadorDirectory flips on.
 * 2-col grid of everyone from GET /v1/profiles (no filter → all profiles).
 */
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import {
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { useConfig, useProfilesAll } from "@/api/hooks";
import { AmbassadorBadge } from "@/components/AmbassadorBadge";
import { Avatar } from "@/components/Avatar";
import { ComingSoon } from "@/components/ComingSoon";
import { EmptyState, ErrorState, LoadingState } from "@/components/ScreenState";
import { schoolMeta } from "@/lib/format";
import { athleteParams } from "@/lib/athleteRoute";
import { goBack } from "@/lib/navigation";
import { track, useScreenView } from "@/telemetry";
import { tokens } from "@/theme/tokens";
import { useTheme } from "@/theme/useTheme";

const GRID_GAP = tokens.spacing.md;

export default function ProfilesScreen() {
  const t = useTheme();
  const router = useRouter();
  const { width } = useWindowDimensions();
  const directoryOn = useConfig().data?.flags.ambassadorDirectory === true;
  const profiles = useProfilesAll();
  useScreenView("profiles");

  if (!directoryOn) return <ComingSoon title="Profiles" />;

  const cardWidth = (width - tokens.spacing.lg * 2 - GRID_GAP) / 2;

  return (
    <SafeAreaView edges={["top"]} style={[styles.screen, { backgroundColor: t.bg }]}>
      <FlatList
        data={profiles.data?.profiles ?? []}
        keyExtractor={(item) => item.id}
        numColumns={2}
        columnWrapperStyle={styles.column}
        contentContainerStyle={styles.content}
        ListHeaderComponent={
          <View>
            <Pressable
              onPress={() => goBack()}
              accessibilityRole="button"
              accessibilityLabel="Back"
              style={styles.back}
            >
              <Ionicons name="chevron-back" size={22} color={t.text} />
              <Text style={[styles.backLabel, { color: t.text }]}>Back</Text>
            </Pressable>
            <Text style={[styles.heading, { color: t.text }]}>Profiles</Text>
            <Text style={[styles.sub, { color: t.subtext }]}>Everyone repping NILTV</Text>
          </View>
        }
        renderItem={({ item }) => (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`View ${item.name}'s profile`}
            onPress={() => {
              track("card_tap", { athleteId: item.id, from: "profiles_directory" });
              router.push({ pathname: "/athlete/[id]", params: athleteParams(item) });
            }}
            style={({ pressed }) => [
              styles.card,
              {
                width: cardWidth,
                backgroundColor: t.surface,
                borderColor: t.line,
                opacity: pressed ? 0.8 : 1,
              },
            ]}
          >
            <Avatar name={item.name} seed={item.id} url={item.avatarUrl} size={62} />
            <Text numberOfLines={1} style={[styles.name, { color: t.text }]}>
              {item.name}
            </Text>
            <Text numberOfLines={2} style={[styles.meta, { color: t.subtext }]}>
              {schoolMeta(item.school, item.sport)}
            </Text>
            {item.isAmbassador ? <AmbassadorBadge size="mini" style={styles.badge} /> : null}
          </Pressable>
        )}
        ListEmptyComponent={
          profiles.isPending ? (
            <LoadingState />
          ) : profiles.isError ? (
            <ErrorState onRetry={() => void profiles.refetch()} />
          ) : (
            <EmptyState message="No profiles yet. Check back soon." />
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
  content: {
    paddingHorizontal: tokens.spacing.lg,
    paddingBottom: tokens.spacing.xl * 2,
    gap: GRID_GAP,
  },
  column: {
    gap: GRID_GAP,
  },
  back: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    paddingVertical: tokens.spacing.md,
    alignSelf: "flex-start",
  },
  backLabel: {
    fontFamily: tokens.font.semibold,
    fontSize: 15,
  },
  heading: {
    fontFamily: tokens.font.extrabold,
    fontSize: 22,
  },
  sub: {
    fontFamily: tokens.font.regular,
    fontSize: 13,
    marginTop: 2,
    marginBottom: tokens.spacing.sm,
  },
  card: {
    alignItems: "center",
    borderWidth: 1,
    borderRadius: tokens.radius,
    paddingVertical: 14,
    paddingHorizontal: tokens.spacing.md,
  },
  name: {
    fontFamily: tokens.font.extrabold,
    fontSize: 14,
    marginTop: tokens.spacing.sm,
  },
  meta: {
    fontFamily: tokens.font.regular,
    fontSize: 11,
    marginTop: 2,
  },
  badge: {
    marginTop: 9,
  },
});
