import { FavoriteSport, type MeFavorites } from "@niltv/types";
import { Ionicons } from "@expo/vector-icons";
import { useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";

import { useChannels, useMe, useProfilesAll, useUpdateFavorites } from "@/api/hooks";
import {
  createFavoritesDraft,
  favoriteSportLabel,
  favoritesErrorMessage,
  favoritesEqual,
  normalizeFavorites,
  schoolOptions,
  toggleFavorite,
} from "@/lib/favorites";
import { nilSchool } from "@/lib/format";
import { tokens } from "@/theme/tokens";
import { useTheme } from "@/theme/useTheme";

type Category = "schools" | "sports" | "channels";

interface FavoriteOption {
  value: string;
  label: string;
}

function ChoiceGroup({
  category,
  title,
  options,
  selected,
  expanded,
  onExpand,
  onToggle,
  loading,
  error,
  onRetry,
}: {
  category: Category;
  title: string;
  options: FavoriteOption[];
  selected: readonly string[];
  expanded: boolean;
  onExpand: () => void;
  onToggle: (value: string) => void;
  loading?: boolean;
  error?: string;
  onRetry?: () => void;
}) {
  const t = useTheme();

  return (
    <View style={styles.group}>
      <Pressable
        accessibilityLabel={`${title}, ${selected.length} selected`}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        onPress={onExpand}
        style={({ pressed }) => [styles.groupHeader, { borderColor: t.line, backgroundColor: t.surface, opacity: pressed ? 0.75 : 1 }]}
      >
        <Text style={[styles.groupTitle, { color: t.text }]}>{title}</Text>
        <Text style={[styles.groupCount, { color: t.subtext }]}>{selected.length}</Text>
        <Ionicons name={expanded ? "chevron-up" : "chevron-down"} size={18} color={t.subtext} />
      </Pressable>
      {expanded ? (
        <View style={styles.groupBody}>
          {loading ? (
            <View style={styles.inlineStatus}>
              <ActivityIndicator size="small" color={t.accent} />
              <Text style={[styles.statusText, { color: t.subtext }]}>Loading {title.toLowerCase()}...</Text>
            </View>
          ) : null}
          {error ? (
            <View style={styles.inlineStatus}>
              <Text accessibilityRole="alert" style={[styles.statusText, { color: t.subtext }]}>{error}</Text>
              {onRetry ? (
                <Pressable accessibilityRole="button" accessibilityLabel={`Retry loading ${title.toLowerCase()}`} onPress={onRetry}>
                  <Text style={[styles.retryText, { color: t.accent }]}>Retry</Text>
                </Pressable>
              ) : null}
            </View>
          ) : null}
          {options.length > 0 ? (
            <View style={styles.options}>
              {options.map((option) => {
                const checked = selected.includes(option.value);
                return (
                  <Pressable
                    key={option.value}
                    accessibilityHint="Double-tap to select or clear this favorite."
                    accessibilityLabel={`Favorite ${category.slice(0, -1)}: ${option.label}`}
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked }}
                    onPress={() => onToggle(option.value)}
                    style={({ pressed }) => [
                      styles.option,
                      {
                        backgroundColor: checked ? tokens.color.gold : t.surface,
                        borderColor: checked ? tokens.color.gold : t.line,
                        opacity: pressed ? 0.72 : 1,
                      },
                    ]}
                  >
                    {checked ? <Ionicons name="checkmark" size={17} color="#0c0c10" /> : null}
                    <Text style={[styles.optionLabel, { color: checked ? "#0c0c10" : t.text }]}>{option.label}</Text>
                  </Pressable>
                );
              })}
            </View>
          ) : !loading && !error ? (
            <Text style={[styles.statusText, { color: t.subtext }]}>No options available.</Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

function InlineStatus({ message, error = false }: { message: string; error?: boolean }) {
  const t = useTheme();
  return <Text accessibilityRole={error ? "alert" : undefined} accessibilityLiveRegion={error ? "assertive" : "polite"} style={[styles.statusText, { color: error ? tokens.color.goldBright : t.subtext }]}>{message}</Text>;
}

export function FavoritesSettings() {
  const t = useTheme();
  const me = useMe();
  const channels = useChannels();
  const profiles = useProfilesAll();
  const saveFavorites = useUpdateFavorites();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<MeFavorites>();
  const [expanded, setExpanded] = useState<Category>("schools");
  const [success, setSuccess] = useState("");

  const saved = me.data?.favorites;
  const activeChannels = channels.data?.channels ?? [];
  const activeChannelIds = activeChannels.map((channel) => channel.id);
  const draftSchools = draft?.schools ?? saved?.schools ?? [];
  const schoolNames = schoolOptions(profiles.data?.profiles, draftSchools);
  const schools: FavoriteOption[] = schoolNames.map((school) => ({ value: school, label: nilSchool(school) }));
  const sports: FavoriteOption[] = FavoriteSport.options.map((sport) => ({ value: sport, label: favoriteSportLabel(sport) }));
  const channelOptions: FavoriteOption[] = activeChannels.map((channel) => ({ value: channel.id, label: channel.name }));
  const changed = Boolean(saved && draft && !favoritesEqual(saved, draft));
  const unavailableChannels = (saved?.channels ?? []).some((id) => !activeChannelIds.includes(id));

  function beginEditing() {
    if (!saved || !channels.isSuccess) return;
    setDraft(createFavoritesDraft(saved, activeChannelIds));
    setExpanded("schools");
    setSuccess("");
    saveFavorites.reset();
    setEditing(true);
  }

  function cancelEditing() {
    setEditing(false);
    setDraft(undefined);
    setSuccess("");
    saveFavorites.reset();
  }

  function toggle(category: Category, value: string) {
    setDraft((current) => current ? { ...current, [category]: toggleFavorite(current[category], value) } : current);
    setSuccess("");
    saveFavorites.reset();
  }

  function save() {
    if (!draft || !changed || saveFavorites.isPending) return;
    saveFavorites.mutate(normalizeFavorites(draft), {
      onSuccess: (updatedMe) => {
        setDraft(updatedMe.favorites);
        setEditing(false);
        setSuccess("Favorites saved.");
      },
    });
  }

  return (
    <View style={[styles.container, { borderColor: t.line }]}>
      <View style={styles.headingRow}>
        <View style={styles.headingCopy}>
          <Text accessibilityRole="header" style={[styles.heading, { color: t.text }]}>Favorites</Text>
          <Text style={[styles.description, { color: t.subtext }]}>Choose the schools, sports, and channels you want to see.</Text>
        </View>
        {!editing && saved ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Edit favorites"
            accessibilityHint="Opens your school, sport, and channel selections."
            disabled={!channels.isSuccess}
            onPress={beginEditing}
            style={({ pressed }) => [styles.editButton, { borderColor: t.accent, opacity: pressed || !channels.isSuccess ? 0.55 : 1 }]}
          >
            <Text style={[styles.editLabel, { color: t.accent }]}>Edit</Text>
          </Pressable>
        ) : null}
      </View>

      {me.isPending ? (
        <View style={styles.inlineStatus}>
          <ActivityIndicator size="small" color={t.accent} />
          <Text style={[styles.statusText, { color: t.subtext }]}>Loading your favorites...</Text>
        </View>
      ) : me.isError ? (
        <View style={styles.inlineStatus}>
          <InlineStatus error message={favoritesErrorMessage(me.error, "load")} />
          <Pressable accessibilityRole="button" accessibilityLabel="Retry loading favorites" onPress={() => void me.refetch()}>
            <Text style={[styles.retryText, { color: t.accent }]}>Retry</Text>
          </Pressable>
        </View>
      ) : channels.isPending ? (
        <View style={styles.inlineStatus}>
          <ActivityIndicator size="small" color={t.accent} />
          <Text style={[styles.statusText, { color: t.subtext }]}>Loading favorite options...</Text>
        </View>
      ) : channels.isError ? (
        <View style={styles.inlineStatus}>
          <InlineStatus error message={favoritesErrorMessage(channels.error, "options")} />
          <Pressable accessibilityRole="button" accessibilityLabel="Retry loading favorite options" onPress={() => void channels.refetch()}>
            <Text style={[styles.retryText, { color: t.accent }]}>Retry</Text>
          </Pressable>
        </View>
      ) : editing && draft ? (
        <View style={styles.editor}>
          {unavailableChannels ? (
            <InlineStatus message="Previously selected channels that are no longer active will be removed if you save." />
          ) : null}
          <ChoiceGroup
            category="schools"
            title="Schools"
            options={schools}
            selected={draft.schools}
            expanded={expanded === "schools"}
            onExpand={() => setExpanded(expanded === "schools" ? "sports" : "schools")}
            onToggle={(value) => toggle("schools", value)}
            loading={profiles.isPending}
            error={profiles.isError ? favoritesErrorMessage(profiles.error, "options") : undefined}
            onRetry={profiles.isError ? () => void profiles.refetch() : undefined}
          />
          <ChoiceGroup
            category="sports"
            title="Sports"
            options={sports}
            selected={draft.sports}
            expanded={expanded === "sports"}
            onExpand={() => setExpanded(expanded === "sports" ? "channels" : "sports")}
            onToggle={(value) => toggle("sports", value)}
          />
          <ChoiceGroup
            category="channels"
            title="Channels"
            options={channelOptions}
            selected={draft.channels}
            expanded={expanded === "channels"}
            onExpand={() => setExpanded(expanded === "channels" ? "schools" : "channels")}
            onToggle={(value) => toggle("channels", value)}
          />
          {saveFavorites.isError ? <InlineStatus error message={favoritesErrorMessage(saveFavorites.error, "save")} /> : null}
          <View style={styles.actions}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Cancel favorite changes"
              disabled={saveFavorites.isPending}
              onPress={cancelEditing}
              style={({ pressed }) => [styles.cancelButton, { borderColor: t.line, opacity: pressed || saveFavorites.isPending ? 0.55 : 1 }]}
            >
              <Text style={[styles.cancelLabel, { color: t.text }]}>Cancel</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Save favorites"
              accessibilityHint="Saves your selected schools, sports, and channels."
              accessibilityState={{ disabled: !changed || saveFavorites.isPending, busy: saveFavorites.isPending }}
              disabled={!changed || saveFavorites.isPending}
              onPress={save}
              style={({ pressed }) => [styles.saveButton, { backgroundColor: tokens.color.gold, opacity: pressed || !changed ? 0.55 : 1 }]}
            >
              {saveFavorites.isPending ? <ActivityIndicator size="small" color="#0c0c10" /> : <Text style={styles.saveLabel}>Save favorites</Text>}
            </Pressable>
          </View>
        </View>
      ) : (
        <View style={styles.summary}>
          <Text style={[styles.summaryText, { color: t.subtext }]}>
            {`${saved?.schools.length ?? 0} schools · ${saved?.sports.length ?? 0} sports · ${saved?.channels.length ?? 0} channels`}
          </Text>
          {success ? <InlineStatus message={success} /> : null}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    borderTopWidth: 1,
    paddingTop: tokens.spacing.lg,
    gap: tokens.spacing.md,
  },
  headingRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: tokens.spacing.md,
  },
  headingCopy: {
    flex: 1,
    minWidth: 0,
    gap: tokens.spacing.xs,
  },
  heading: {
    fontFamily: tokens.font.bold,
    fontSize: tokens.text.section,
  },
  description: {
    fontFamily: tokens.font.regular,
    fontSize: tokens.text.meta,
    lineHeight: 19,
  },
  editButton: {
    minHeight: 44,
    justifyContent: "center",
    paddingHorizontal: tokens.spacing.md,
    borderWidth: 1,
    borderRadius: 8,
  },
  editLabel: {
    fontFamily: tokens.font.bold,
    fontSize: tokens.text.body,
  },
  summary: {
    gap: tokens.spacing.xs,
  },
  summaryText: {
    fontFamily: tokens.font.regular,
    fontSize: tokens.text.body,
    lineHeight: 21,
  },
  editor: {
    gap: tokens.spacing.md,
  },
  group: {
    gap: tokens.spacing.sm,
  },
  groupHeader: {
    minHeight: 48,
    flexDirection: "row",
    alignItems: "center",
    gap: tokens.spacing.sm,
    paddingHorizontal: tokens.spacing.md,
    paddingVertical: tokens.spacing.sm,
    borderWidth: 1,
    borderRadius: 8,
  },
  groupTitle: {
    flex: 1,
    fontFamily: tokens.font.bold,
    fontSize: tokens.text.body,
  },
  groupCount: {
    fontFamily: tokens.font.semibold,
    fontSize: tokens.text.meta,
  },
  groupBody: {
    gap: tokens.spacing.sm,
    paddingHorizontal: tokens.spacing.xs,
  },
  options: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: tokens.spacing.sm,
  },
  option: {
    maxWidth: "100%",
    minHeight: 48,
    flexDirection: "row",
    alignItems: "center",
    gap: tokens.spacing.xs,
    paddingHorizontal: tokens.spacing.md,
    paddingVertical: tokens.spacing.sm,
    borderWidth: 1,
    borderRadius: 8,
    flexShrink: 1,
  },
  optionLabel: {
    flexShrink: 1,
    fontFamily: tokens.font.semibold,
    fontSize: tokens.text.meta,
    lineHeight: 19,
  },
  inlineStatus: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: tokens.spacing.sm,
  },
  statusText: {
    flexShrink: 1,
    fontFamily: tokens.font.regular,
    fontSize: tokens.text.meta,
    lineHeight: 19,
  },
  retryText: {
    fontFamily: tokens.font.bold,
    fontSize: tokens.text.meta,
    paddingVertical: tokens.spacing.xs,
  },
  actions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: tokens.spacing.sm,
  },
  cancelButton: {
    minHeight: 48,
    flexGrow: 1,
    flexBasis: 110,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: tokens.spacing.md,
    paddingVertical: tokens.spacing.sm,
    borderWidth: 1,
    borderRadius: 8,
  },
  cancelLabel: {
    fontFamily: tokens.font.semibold,
    fontSize: tokens.text.body,
  },
  saveButton: {
    minHeight: 48,
    flexGrow: 2,
    flexBasis: 160,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: tokens.spacing.md,
    paddingVertical: tokens.spacing.sm,
    borderRadius: 8,
  },
  saveLabel: {
    color: "#0c0c10",
    fontFamily: tokens.font.bold,
    fontSize: tokens.text.body,
    textAlign: "center",
  },
});