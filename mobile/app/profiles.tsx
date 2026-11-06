/**
 * Public athlete directory with recent-video previews.
 * Discover athletes with videos, or browse the complete cleared roster.
 */
import { Ionicons } from "@expo/vector-icons";
import { useState } from "react";
import {
  FlatList,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { useProfilesAll } from "@/api/hooks";
import { AthleteDirectoryCard } from "@/components/AthleteDirectoryCard";
import { SegmentedControl } from "@/components/SegmentedControl";
import { EmptyState, ErrorState, LoadingState } from "@/components/ScreenState";
import { Sheet } from "@/components/Sheet";
import { nilSchool } from "@/lib/format";
import { athleteFilterOptions, discoverAthletes, filterAthletes, spotlightAthlete } from "@/lib/athleteDirectory";
import { goBack } from "@/lib/navigation";
import { useScreenView } from "@/telemetry";
import { tokens } from "@/theme/tokens";
import { useTheme } from "@/theme/useTheme";

const GRID_GAP = tokens.spacing.md;

export default function ProfilesScreen() {
  const t = useTheme();
  const profiles = useProfilesAll(true);
  const [tab, setTab] = useState("Discover");
  const discovering = tab === "Discover";
  const [name, setName] = useState("");
  const [school, setSchool] = useState("");
  const [sport, setSport] = useState("");
  const [picker, setPicker] = useState<"school" | "sport" | null>(null);
  const athletes = profiles.data?.profiles ?? [];
  const initialError = profiles.isError && !profiles.data;
  const matched = filterAthletes(athletes, name, school, sport);
  const results = discovering ? discoverAthletes(matched) : matched;
  const filtered = Boolean(name.trim() || school || sport);
  const options = picker ? athleteFilterOptions(athletes, picker) : [];
  const spotlight = discovering && !filtered ? spotlightAthlete(results) : undefined;
  useScreenView("profiles");

  return (
    <SafeAreaView edges={["top"]} style={[styles.screen, { backgroundColor: t.bg }]}>
      <FlatList
        data={spotlight ? results.filter((athlete) => athlete.id !== spotlight.id) : results}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        refreshing={profiles.isRefetching}
        onRefresh={() => void profiles.refetch()}
        keyExtractor={(item) => item.id}
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
            <View style={styles.intro}>
              <View style={[styles.kickerLine, { backgroundColor: t.accent }]} />
              <Text style={[styles.kicker, { color: t.accent }]}>THE NILTV ROSTER</Text>
            </View>
            <Text style={[styles.heading, { color: t.text }]}>Athletes</Text>
            <Text style={[styles.sub, { color: t.subtext }]}>Discover the athletes and stories behind the game.</Text>
            <View style={styles.tabs}>
              <SegmentedControl options={["Discover", "All athletes"]} value={tab} onChange={setTab} />
            </View>
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
              {name.length > 0 ? (
                <Pressable accessibilityRole="button" accessibilityLabel="Clear search" onPress={() => setName("")} hitSlop={8}>
                  <Ionicons name="close-circle" size={20} color={t.subtext} />
                </Pressable>
              ) : null}
            </View>
            <View style={styles.filters}>
              {(["school", "sport"] as const).map((field) => (
                <Pressable
                  key={field}
                  accessibilityRole="button"
                  accessibilityLabel={`Filter by ${field}, ${field === "school" ? (school ? nilSchool(school) : "all schools") : sport || "all sports"}`}
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
            {profiles.isError && profiles.data ? (
              <Pressable accessibilityRole="button" onPress={() => void profiles.refetch()} style={[styles.refreshNotice, { borderColor: t.line, backgroundColor: t.surface }]}>
                <Text style={[styles.refreshText, { color: t.subtext }]}>Couldn’t refresh athletes. Showing previous results.</Text>
                <Text style={[styles.action, { color: t.accent }]}>Retry</Text>
              </Pressable>
            ) : null}
            {discovering && !filtered && spotlight ? (
              <View style={styles.spotlight}>
                <AthleteDirectoryCard athlete={spotlight} discover spotlight />
              </View>
            ) : null}
            {!profiles.isPending && !initialError ? <View style={styles.resultsRow}>
              <View style={styles.resultsCopy}>
                <Text style={[styles.resultsTitle, { color: t.text }]}>{discovering ? "Latest from athletes" : "The roster"}</Text>
                <Text style={[styles.count, { color: t.subtext }]}>{results.length} {results.length === 1 ? "athlete" : "athletes"}{discovering ? " with videos" : " · A–Z"}</Text>
              </View>
              {filtered ? (
                <Pressable accessibilityRole="button" style={styles.clearFilters} onPress={() => { setName(""); setSchool(""); setSport(""); }}>
                  <Text style={[styles.action, { color: t.accent }]}>Clear filters</Text>
                </Pressable>
                ) : null}
              </View> : null}
          </View>
        }
        renderItem={({ item }) => (
          <AthleteDirectoryCard athlete={item} discover={discovering} />
        )}
        ListEmptyComponent={
          profiles.isPending ? (
            <LoadingState />
          ) : initialError ? (
            <ErrorState onRetry={() => void profiles.refetch()} />
          ) : spotlight ? null : (
            <View>
              <EmptyState message={discovering ? (filtered ? "No videos match these filters yet." : "New athlete videos will appear here.") : filtered ? "No athletes match. Try another name or clear the filters." : "No athletes yet. Check back soon."} />
              {discovering ? (
                <Pressable accessibilityRole="button" onPress={() => setTab("All athletes")} style={styles.browseAll}>
                  <Text style={[styles.action, { color: t.accent }]}>Browse all athletes</Text>
                </Pressable>
              ) : null}
            </View>
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
    width: "100%",
    maxWidth: 680,
    alignSelf: "center",
    paddingHorizontal: tokens.spacing.lg,
    paddingBottom: tokens.spacing.xl * 2,
    gap: GRID_GAP,
  },
  tabs: { marginBottom: tokens.spacing.md },
  spotlight: { marginTop: tokens.spacing.sm, marginBottom: tokens.spacing.md },
  browseAll: { minHeight: 48, alignItems: "center", justifyContent: "center" },
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
  intro: { flexDirection: "row", alignItems: "center", gap: tokens.spacing.sm, marginTop: tokens.spacing.sm },
  kickerLine: { width: 20, height: 2 },
  kicker: { fontFamily: tokens.font.bold, fontSize: 10, letterSpacing: 1.3 },
  heading: {
    fontFamily: tokens.font.extrabold,
    fontSize: tokens.text.hero,
    lineHeight: 50,
  },
  sub: {
    fontFamily: tokens.font.regular,
    fontSize: 14,
    lineHeight: 21,
    marginTop: 2,
    marginBottom: tokens.spacing.xl,
  },
  searchBox: { flexDirection: "row", alignItems: "center", gap: tokens.spacing.sm, borderWidth: 1, borderRadius: tokens.radius, paddingHorizontal: tokens.spacing.md, marginBottom: tokens.spacing.md },
  search: { flex: 1, minHeight: 48, paddingVertical: tokens.spacing.md, fontFamily: tokens.font.regular, fontSize: tokens.text.body },
  filters: { flexDirection: "row", alignItems: "center", gap: GRID_GAP, marginBottom: tokens.spacing.sm },
  filter: { flex: 1, flexDirection: "row", alignItems: "center", gap: tokens.spacing.sm, borderWidth: 1, borderRadius: tokens.radius, padding: tokens.spacing.md, minHeight: 64 },
  filterCopy: { flex: 1, gap: tokens.spacing.xs },
  filterCaption: { fontFamily: tokens.font.semibold, fontSize: tokens.text.label },
  filterLabel: { flex: 1, fontFamily: tokens.font.regular, fontSize: 13 },
  refreshNotice: { flexDirection: "row", alignItems: "center", gap: tokens.spacing.md, borderWidth: 1, borderRadius: tokens.radius, padding: tokens.spacing.md, marginTop: tokens.spacing.sm },
  refreshText: { flex: 1, fontFamily: tokens.font.regular, fontSize: 12, lineHeight: 18 },
  resultsRow: { flexDirection: "row", alignItems: "center", minHeight: 60, marginTop: tokens.spacing.sm, marginBottom: tokens.spacing.xs },
  resultsCopy: { flex: 1, gap: 3 },
  resultsTitle: { fontFamily: tokens.font.extrabold, fontSize: 21 },
  clearFilters: { minHeight: 44, justifyContent: "center", paddingHorizontal: tokens.spacing.xs },
  count: { fontFamily: tokens.font.regular, fontSize: 13 },
  action: { fontFamily: tokens.font.semibold, fontSize: 13 },
  options: { maxHeight: 360 },
  option: { minHeight: 48, flexDirection: "row", alignItems: "center", gap: tokens.spacing.sm, paddingVertical: tokens.spacing.md, paddingHorizontal: tokens.spacing.xs, borderBottomWidth: 1 },
});
