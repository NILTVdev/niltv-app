/**
 * Profiles directory (demo screen-profiles, design §3.1) — built but DARK:
 * renders a themed "Coming soon" until flags.ambassadorDirectory flips on.
 * 2-col grid of everyone from GET /v1/profiles (no filter → all profiles).
 */
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useMemo, useState } from "react";
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
import { AmbassadorBadge } from "@/components/AmbassadorBadge";
import { Avatar } from "@/components/Avatar";
import { ComingSoon } from "@/components/ComingSoon";
import { EmptyState, ErrorState, LoadingState } from "@/components/ScreenState";
import { schoolMeta } from "@/lib/format";
import { athleteParams } from "@/lib/athleteRoute";
import { goBack } from "@/lib/navigation";
import { NO_FILTERS, filterOptions, filterProfiles } from "@/lib/profileFilter";
import { track, useScreenView } from "@/telemetry";
import { tokens } from "@/theme/tokens";
import { useTheme } from "@/theme/useTheme";

const GRID_GAP = tokens.spacing.md;

/** One horizontally scrolling row of single-select chips; tapping the active one clears it. */
function ChipRow({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: string[];
  value: string | null;
  onChange: (next: string | null) => void;
}) {
  const t = useTheme();
  if (options.length === 0) return null;
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      style={styles.chipRow}
      contentContainerStyle={styles.chipRowContent}
    >
      {options.map((option) => {
        const active = option === value;
        return (
          <Pressable
            key={option}
            accessibilityRole="button"
            accessibilityLabel={`${label}: ${option}`}
            accessibilityState={{ selected: active }}
            onPress={() => onChange(active ? null : option)}
            style={[
              styles.chip,
              { backgroundColor: active ? t.accent : t.inset, borderColor: active ? t.accent : t.line },
            ]}
          >
            <Text style={[styles.chipLabel, { color: active ? "#060608" : t.text }]}>{option}</Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

export default function ProfilesScreen() {
  const t = useTheme();
  const router = useRouter();
  const { width } = useWindowDimensions();
  const directoryOn = useConfig().data?.flags.ambassadorDirectory === true;
  const profiles = useProfilesAll();
  useScreenView("profiles");
  const [filters, setFilters] = useState(NO_FILTERS);
  const all = useMemo(() => profiles.data?.profiles ?? [], [profiles.data]);
  const schools = useMemo(() => filterOptions(all, "school"), [all]);
  const sports = useMemo(() => filterOptions(all, "sport"), [all]);
  const shown = useMemo(() => filterProfiles(all, filters), [all, filters]);

  if (!directoryOn) return <ComingSoon title="Profiles" />;

  const cardWidth = (width - tokens.spacing.lg * 2 - GRID_GAP) / 2;

  return (
    <SafeAreaView edges={["top"]} style={[styles.screen, { backgroundColor: t.bg }]}>
      <FlatList
        data={shown}
        keyboardShouldPersistTaps="handled"
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
            <TextInput
              value={filters.query}
              onChangeText={(query) => setFilters((f) => ({ ...f, query }))}
              placeholder="Search by name"
              placeholderTextColor={t.subtext}
              accessibilityLabel="Search athletes by name"
              autoCapitalize="none"
              autoCorrect={false}
              clearButtonMode="while-editing"
              returnKeyType="search"
              style={[styles.search, { backgroundColor: t.inset, color: t.text }]}
            />
            <ChipRow
              label="School"
              options={schools}
              value={filters.school}
              onChange={(school) => setFilters((f) => ({ ...f, school }))}
            />
            <ChipRow
              label="Sport"
              options={sports}
              value={filters.sport}
              onChange={(sport) => setFilters((f) => ({ ...f, sport }))}
            />
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
          ) : all.length > 0 ? (
            <EmptyState message="No athletes match those filters." />
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
  search: {
    fontFamily: tokens.font.regular,
    fontSize: 15,
    borderRadius: tokens.radius,
    paddingHorizontal: tokens.spacing.md,
    paddingVertical: 10,
    marginBottom: tokens.spacing.sm,
  },
  chipRow: {
    marginBottom: tokens.spacing.sm,
  },
  chipRowContent: {
    gap: tokens.spacing.sm,
  },
  chip: {
    borderWidth: 1,
    borderRadius: 999,
    paddingVertical: 6,
    paddingHorizontal: 12,
  },
  chipLabel: {
    fontFamily: tokens.font.semibold,
    fontSize: 13,
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
