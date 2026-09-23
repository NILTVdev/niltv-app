/**
 * Ambassadors hub (demo screen-ambassadors, design §3.1) — built but DARK:
 * renders a themed "Coming soon" until flags.ambassadorDirectory flips on.
 * Hero band + "Top of the month" leaderboard from GET /v1/profiles?filter=ambassador.
 */
import { Ionicons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import { useRouter } from "expo-router";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { useAmbassadors, useConfig } from "@/api/hooks";
import { Avatar } from "@/components/Avatar";
import { ComingSoon } from "@/components/ComingSoon";
import { EmptyState, ErrorState, LoadingState } from "@/components/ScreenState";
import { schoolMeta } from "@/lib/format";
import { athleteParams } from "@/lib/athleteRoute";
import { goBack } from "@/lib/navigation";
import { track, useScreenView } from "@/telemetry";
import { tokens } from "@/theme/tokens";
import { useTheme } from "@/theme/useTheme";

export default function AmbassadorsScreen() {
  const t = useTheme();
  const router = useRouter();
  const directoryOn = useConfig().data?.flags.ambassadorDirectory === true;
  const ambassadors = useAmbassadors();
  useScreenView("ambassadors");

  if (!directoryOn) return <ComingSoon title="NILTV Ambassadors" />;

  const ranked = [...(ambassadors.data?.profiles ?? [])].sort(
    (a, b) => (a.ambassadorRank ?? Number.MAX_SAFE_INTEGER) - (b.ambassadorRank ?? Number.MAX_SAFE_INTEGER),
  );

  return (
    <SafeAreaView edges={["top"]} style={[styles.screen, { backgroundColor: t.bg }]}>
      <ScrollView contentContainerStyle={styles.content}>
        <Pressable
          onPress={() => goBack()}
          accessibilityRole="button"
          accessibilityLabel="Back"
          style={styles.back}
        >
          <Ionicons name="chevron-back" size={22} color={t.text} />
          <Text style={[styles.backLabel, { color: t.text }]}>Back</Text>
        </Pressable>

        {/* Hero band (demo .newshero) */}
        <LinearGradient
          colors={["#1a1a1f", "#2a2418"]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={styles.hero}
        >
          <Ionicons name="star" size={120} color={tokens.color.gold} style={styles.heroStar} />
          <Text style={styles.kicker}>NILTV Ambassadors</Text>
          <Text style={styles.heroTitle}>
            Our <Text style={{ color: tokens.color.gold }}>Ambassadors</Text>
          </Text>
          <Text style={styles.heroCopy}>
            Athletes repping NILTV across campus. The top performers each month earn a
            featured spot.
          </Text>
        </LinearGradient>

        <View style={styles.sectionRow}>
          <Text style={[styles.section, { color: t.text }]}>Top of the month</Text>
          <Pressable
            onPress={() => router.push("/profiles")}
            accessibilityRole="link"
            accessibilityLabel="See all profiles"
          >
            <Text style={[styles.seeAll, { color: t.accent }]}>See all ›</Text>
          </Pressable>
        </View>
        <Text style={[styles.sub, { color: t.subtext }]}>
          Ranked by views &amp; posts · refreshes monthly · curated by NILTV
        </Text>

        {ambassadors.isPending ? <LoadingState /> : null}
        {ambassadors.isError && !ambassadors.data ? (
          <ErrorState onRetry={() => void ambassadors.refetch()} />
        ) : null}
        {ambassadors.data && ranked.length === 0 ? (
          <EmptyState message="No ambassadors yet. Check back soon." />
        ) : null}

        {ranked.map((a, index) => (
          <Pressable
            key={a.id}
            accessibilityRole="button"
            accessibilityLabel={`View ${a.name}'s profile`}
            onPress={() => {
              track("card_tap", { athleteId: a.id, from: "ambassadors_leaderboard" });
              router.push({ pathname: "/athlete/[id]", params: athleteParams(a) });
            }}
            style={({ pressed }) => [
              styles.row,
              { backgroundColor: t.surface, borderColor: t.line, opacity: pressed ? 0.8 : 1 },
            ]}
          >
            <Text style={[styles.rank, { color: t.accent }]}>{a.ambassadorRank ?? index + 1}</Text>
            <Avatar name={a.name} seed={a.id} url={a.avatarUrl} size={42} />
            <View style={styles.rowBody}>
              <Text numberOfLines={1} style={[styles.rowName, { color: t.text }]}>
                {a.name}
              </Text>
              <Text numberOfLines={2} style={[styles.rowMeta, { color: t.subtext }]}>
                {schoolMeta(a.school, a.sport)}
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={t.subtext} />
          </Pressable>
        ))}
      </ScrollView>
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
  hero: {
    borderRadius: tokens.radius,
    padding: 20,
    overflow: "hidden",
  },
  heroStar: {
    position: "absolute",
    right: -14,
    top: -18,
    opacity: 0.14,
  },
  kicker: {
    color: tokens.color.gold,
    fontFamily: tokens.font.extrabold,
    fontSize: 11,
    letterSpacing: 1.2,
    textTransform: "uppercase",
  },
  heroTitle: {
    color: "#ffffff",
    fontFamily: tokens.font.extrabold,
    fontSize: 26,
    letterSpacing: 0.2,
    marginTop: tokens.spacing.sm,
  },
  heroCopy: {
    color: "#d9d4c4",
    fontFamily: tokens.font.regular,
    fontSize: 13,
    lineHeight: 19,
    marginTop: tokens.spacing.sm,
  },
  sectionRow: {
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "space-between",
    marginTop: tokens.spacing.xl,
  },
  section: {
    fontFamily: tokens.font.extrabold,
    fontSize: 17,
  },
  seeAll: {
    fontFamily: tokens.font.bold,
    fontSize: 13,
  },
  sub: {
    fontFamily: tokens.font.regular,
    fontSize: 12,
    marginTop: 4,
    marginBottom: tokens.spacing.md,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: tokens.spacing.md,
    borderWidth: 1,
    borderRadius: tokens.radius,
    paddingVertical: 10,
    paddingHorizontal: tokens.spacing.md,
    marginBottom: tokens.spacing.sm,
  },
  rank: {
    fontFamily: tokens.font.extrabold,
    fontSize: 16,
    width: 24,
    textAlign: "center",
  },
  rowBody: {
    flex: 1,
    minWidth: 0,
  },
  rowName: {
    fontFamily: tokens.font.extrabold,
    fontSize: 15,
  },
  rowMeta: {
    fontFamily: tokens.font.regular,
    fontSize: 12,
    marginTop: 1,
  },
});
