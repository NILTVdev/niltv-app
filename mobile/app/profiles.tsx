/**
 * Profiles directory (demo screen-profiles, design §3.1) — built but DARK:
 * renders a themed "Coming soon" until flags.ambassadorDirectory flips on.
 * Searchable 2-col grid of publicly cleared athletes from GET /v1/profiles.
 */
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useState } from "react";
import {
  FlatList,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { useConfig, useProfilesAll } from "@/api/hooks";
import { Avatar } from "@/components/Avatar";
import { AthleteRecentVideos } from "@/components/AthleteRecentVideos";
import { ComingSoon } from "@/components/ComingSoon";
import { EmptyState, ErrorState, LoadingState } from "@/components/ScreenState";
import { Sheet } from "@/components/Sheet";
import { nilSchool } from "@/lib/format";
import { athleteFilterOptions, filterAthletes } from "@/lib/athleteDirectory";
import { athleteParams } from "@/lib/athleteRoute";
import { goBack } from "@/lib/navigation";
import { useScreenView } from "@/telemetry";
import { tokens } from "@/theme/tokens";
import { useTheme } from "@/theme/useTheme";

const GRID_GAP = tokens.spacing.md;

export default function ProfilesScreen() {
  const t = useTheme();
  const router = useRouter();
  const { width } = useWindowDimensions();
  const directoryOn = useConfig().data?.flags.ambassadorDirectory === true;
  const profiles = useProfilesAll();
  const [name, setName] = useState("");
  const [school, setSchool] = useState("");
  const [sport, setSport] = useState("");
  const [picker, setPicker] = useState<"school" | "sport" | null>(null);
  const athletes = profiles.isError ? [] : profiles.data?.profiles ?? [];
  const results = filterAthletes(athletes, name, school, sport);
  const filtered = Boolean(name || school || sport);
  const options = picker ? athleteFilterOptions(athletes, picker) : [];
  useScreenView("profiles");

  if (!directoryOn) return <ComingSoon title="Athletes" />;

  const cardWidth = Math.floor((width - tokens.spacing.lg * 2 - GRID_GAP) / 2);

  return (
    <SafeAreaView edges={["top"]} style={[styles.screen, { backgroundColor: t.bg }]}>
      <FlatList
        data={results}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        refreshing={profiles.isRefetching}
        onRefresh={() => void profiles.refetch()}
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
            <Text style={[styles.heading, { color: t.text }]}>Athletes</Text>
            <Text style={[styles.sub, { color: t.subtext }]}>Everyone repping NILTV</Text>
            <View style={[styles.searchBox, { borderColor: t.line, backgroundColor: t.surface }]}>
              <Ionicons name="search-outline" size={18} color={t.subtext} />
              <TextInput
                value={name}
                onChangeText={setName}
                placeholder="Search by name"
                placeholderTextColor={t.subtext}
                accessibilityLabel="Search athletes by name"
                autoCorrect={false}
                style={[styles.search, { color: t.text }]}
              />
            </View>
            <View style={styles.filters}>
              {(["school", "sport"] as const).map((field) => (
                <Pressable
                  key={field}
                  accessibilityRole="button"
                  accessibilityLabel={`Filter by ${field}`}
                  onPress={() => setPicker(field)}
                  style={({ pressed }) => [styles.filter, {
                    borderColor: (field === "school" ? school : sport) ? t.accent : t.line,
                    backgroundColor: pressed ? t.inset : t.surface,
                  }]}
                >
                  <View style={styles.filterCopy}>
                    <Text style={[styles.filterCaption, { color: t.subtext }]}>{field === "school" ? "School" : "Sport"}</Text>
                    <Text numberOfLines={2} style={[styles.filterLabel, { color: t.text }]}>
                      {field === "school" ? (school ? nilSchool(school) : "All schools") : sport || "All sports"}
                    </Text>
                  </View>
                  <Ionicons name="chevron-down" size={16} color={t.subtext} />
                </Pressable>
              ))}
            </View>
            <View style={styles.resultsRow}>
              <Text style={[styles.count, { color: t.subtext }]}>{results.length} {results.length === 1 ? "athlete" : "athletes"}</Text>
              {filtered ? (
                <Pressable accessibilityRole="button" style={styles.clearFilters} onPress={() => { setName(""); setSchool(""); setSport(""); }}>
                  <Text style={[styles.action, { color: t.accent }]}>Clear filters</Text>
                </Pressable>
                ) : null}
              </View>
          </View>
        }
        renderItem={({ item }) => (
          <View style={[styles.card, { width: cardWidth, backgroundColor: t.surface, borderColor: t.line }]}>
            <Pressable
              accessibilityRole="link"
              accessibilityLabel={`Watch ${item.name}'s videos`}
              onPress={() => router.push({ pathname: "/athlete/[id]", params: { ...athleteParams(item), videos: "1" } })}
              style={({ pressed }) => [StyleSheet.absoluteFill, { backgroundColor: pressed ? t.inset : t.surface }]}
            />
            <View pointerEvents="none" style={styles.cardIdentity}>
              <Avatar name={item.name} seed={item.id} url={item.avatarUrl} size={68} />
              <View style={styles.nameLink}>
                <Text numberOfLines={2} style={[styles.name, { color: t.text }]}>{item.name}</Text>
              </View>
              <Text numberOfLines={2} style={[styles.meta, { color: t.subtext }]}>{nilSchool(item.school)}</Text>
              {item.sport ? <Text numberOfLines={1} style={[styles.sport, { color: t.text }]}>{item.sport}</Text> : null}
            </View>
            <AthleteRecentVideos athleteId={item.id} name={item.name} />
          </View>
        )}
        ListEmptyComponent={
          profiles.isPending ? (
            <LoadingState />
          ) : profiles.isError ? (
            <ErrorState onRetry={() => void profiles.refetch()} />
          ) : (
            <EmptyState message={filtered ? "No athletes match. Try another name or clear the filters." : "No athletes yet. Check back soon."} />
          )
        }
      />
      <Sheet visible={picker !== null} onClose={() => setPicker(null)} title={picker === "school" ? "School" : "Sport"}>
        <ScrollView style={styles.options} keyboardShouldPersistTaps="handled">
          {["", ...options].map((value) => (
            <Pressable
              key={value}
              accessibilityRole="button"
              accessibilityState={{ selected: value === (picker === "school" ? school : sport) }}
              onPress={() => { if (picker === "school") setSchool(value); else setSport(value); setPicker(null); }}
              style={({ pressed }) => [styles.option, { borderColor: t.line, backgroundColor: pressed ? t.inset : t.surface }]}
            >
              <Text style={[styles.filterLabel, { color: t.text }]}>
                {value ? (picker === "school" ? nilSchool(value) : value) : picker === "school" ? "All schools" : "All sports"}
              </Text>
              {value === (picker === "school" ? school : sport) ? <Ionicons name="checkmark" size={18} color={t.accent} /> : null}
            </Pressable>
          ))}
        </ScrollView>
      </Sheet>
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
    fontSize: tokens.text.screen,
  },
  sub: {
    fontFamily: tokens.font.regular,
    fontSize: 13,
    marginTop: 2,
    marginBottom: tokens.spacing.md,
  },
  cardIdentity: { alignSelf: "stretch", alignItems: "center" },
  card: {
    overflow: "hidden",
    alignItems: "center",
    borderWidth: 1,
    borderRadius: tokens.radius,
    paddingTop: tokens.spacing.lg,
    paddingBottom: tokens.spacing.sm,
    paddingHorizontal: tokens.spacing.md,
  },
  name: {
    fontFamily: tokens.font.semibold,
    fontSize: tokens.text.body,
    lineHeight: 20,
    textAlign: "center",
  },
  meta: {
    fontFamily: tokens.font.regular,
    fontSize: 11,
    lineHeight: 16,
    minHeight: 32,
    marginTop: 2,
    textAlign: "center",
  },
  nameLink: { alignSelf: "stretch", minHeight: 44, justifyContent: "center", marginTop: tokens.spacing.sm },
  sport: { fontFamily: tokens.font.semibold, fontSize: tokens.text.label, marginTop: tokens.spacing.xs, textAlign: "center" },
  badgeSlot: { minHeight: 24, justifyContent: "center", marginTop: tokens.spacing.xs },
  cardActions: { alignSelf: "stretch", marginTop: "auto", paddingTop: tokens.spacing.sm },
  videoAction: { borderWidth: 1, borderRadius: tokens.radius },
  profileSlot: { minHeight: 44 },
  searchBox: { flexDirection: "row", alignItems: "center", gap: tokens.spacing.sm, borderWidth: 1, borderRadius: tokens.radius, paddingHorizontal: tokens.spacing.md, marginBottom: tokens.spacing.md },
  search: { flex: 1, minHeight: 48, paddingVertical: tokens.spacing.md, fontFamily: tokens.font.regular, fontSize: tokens.text.body },
  filters: { flexDirection: "row", alignItems: "center", gap: GRID_GAP, marginBottom: tokens.spacing.sm },
  filter: { flex: 1, flexDirection: "row", alignItems: "center", gap: tokens.spacing.sm, borderWidth: 1, borderRadius: tokens.radius, padding: tokens.spacing.md, minHeight: 64 },
  filterCopy: { flex: 1, gap: tokens.spacing.xs },
  filterCaption: { fontFamily: tokens.font.semibold, fontSize: tokens.text.label },
  filterLabel: { flex: 1, fontFamily: tokens.font.regular, fontSize: 13 },
  resultsRow: { flexDirection: "row", alignItems: "center", minHeight: 44, marginBottom: tokens.spacing.xs },
  clearFilters: { minHeight: 44, justifyContent: "center", paddingHorizontal: tokens.spacing.xs },
  count: { flex: 1, fontFamily: tokens.font.regular, fontSize: 13 },
  action: { fontFamily: tokens.font.semibold, fontSize: 13 },
  cardAction: { flexDirection: "row", gap: tokens.spacing.xs, minHeight: 44, justifyContent: "center", alignSelf: "stretch", alignItems: "center" },
  options: { maxHeight: 360 },
  option: { minHeight: 48, flexDirection: "row", alignItems: "center", gap: tokens.spacing.sm, paddingVertical: tokens.spacing.md, paddingHorizontal: tokens.spacing.xs, borderBottomWidth: 1 },
});
