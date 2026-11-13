import type { AppearancePreference } from "@niltv/types";
import { Ionicons } from "@expo/vector-icons";
import { useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";

import { useMe, useUpdateAppearance } from "@/api/hooks";
import { GoldButton } from "@/components/GoldButton";
import { appearanceLabel, appearanceSaveErrorMessage, APPEARANCE_OPTIONS } from "@/theme/appearance";
import { tokens } from "@/theme/tokens";
import { useTheme } from "@/theme/useTheme";

export function AppearanceSettings() {
  const t = useTheme();
  const me = useMe();
  const updateAppearance = useUpdateAppearance();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<AppearancePreference | null>(null);
  const [success, setSuccess] = useState("");
  const saved = me.data?.appearance ?? "system";
  const changed = draft !== null && draft !== saved;

  function beginEditing() {
    if (!me.data) return;
    setDraft(saved);
    setSuccess("");
    updateAppearance.reset();
    setEditing(true);
  }

  function cancelEditing() {
    setDraft(null);
    setEditing(false);
    setSuccess("");
    updateAppearance.reset();
  }

  function save() {
    if (!draft || !changed || updateAppearance.isPending) return;
    updateAppearance.mutate(
      { appearance: draft },
      {
        onSuccess: () => {
          setDraft(null);
          setEditing(false);
          setSuccess("Appearance saved.");
        },
      },
    );
  }

  return (
    <View style={[styles.container, { borderColor: t.line }]}>
      <View style={styles.headingRow}>
        <View style={styles.headingCopy}>
          <Text accessibilityRole="header" style={[styles.heading, { color: t.text }]}>Appearance</Text>
          <Text style={[styles.description, { color: t.subtext }]}>Choose how NILTV looks on this device.</Text>
        </View>
        {!editing && me.data ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Edit appearance"
            accessibilityHint="Choose light, dark, or device appearance."
            onPress={beginEditing}
            style={({ pressed }) => [styles.editButton, { borderColor: t.accent, opacity: pressed ? 0.7 : 1 }]}
          >
            <Text style={[styles.editLabel, { color: t.accent }]}>Edit</Text>
          </Pressable>
        ) : null}
      </View>

      {me.isPending ? (
        <View style={styles.statusRow}>
          <ActivityIndicator size="small" color={t.accent} />
          <Text style={[styles.statusText, { color: t.subtext }]}>Loading appearance...</Text>
        </View>
      ) : me.isError ? (
        <View style={styles.statusRow}>
          <Text accessibilityRole="alert" style={[styles.statusText, { color: t.danger }]}>Could not load your appearance setting.</Text>
          <Pressable accessibilityRole="button" accessibilityLabel="Retry loading appearance" onPress={() => void me.refetch()}>
            <Text style={[styles.actionText, { color: t.accent }]}>Retry</Text>
          </Pressable>
        </View>
      ) : editing && draft !== null ? (
        <View style={styles.editor}>
          <View accessibilityLabel="Appearance options" style={styles.options}>
            {APPEARANCE_OPTIONS.map((option) => {
              const selected = draft === option.value;
              return (
                <Pressable
                  key={option.value}
                  accessibilityRole="radio"
                  accessibilityLabel={option.label}
                  accessibilityHint={option.description}
                  accessibilityState={{ selected, disabled: updateAppearance.isPending }}
                  disabled={updateAppearance.isPending}
                  onPress={() => {
                    setDraft(option.value);
                    setSuccess("");
                    updateAppearance.reset();
                  }}
                  style={({ pressed }) => [
                    styles.option,
                    {
                      borderColor: selected ? t.accent : t.line,
                      backgroundColor: selected ? t.inset : t.surface,
                      opacity: pressed || updateAppearance.isPending ? 0.7 : 1,
                    },
                  ]}
                >
                  <View style={[styles.radio, { borderColor: selected ? t.accent : t.subtext }]}>
                    {selected ? <View style={[styles.radioDot, { backgroundColor: t.accent }]} /> : null}
                  </View>
                  <View style={styles.optionCopy}>
                    <Text style={[styles.optionLabel, { color: t.text }]}>{option.label}</Text>
                    <Text style={[styles.optionDescription, { color: t.subtext }]}>{option.description}</Text>
                  </View>
                </Pressable>
              );
            })}
          </View>

          {updateAppearance.isError ? (
            <Text accessibilityRole="alert" style={[styles.statusText, { color: t.danger }]}>
              {appearanceSaveErrorMessage(updateAppearance.error)}
            </Text>
          ) : null}
          <View style={styles.actions}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Cancel appearance changes"
              disabled={updateAppearance.isPending}
              onPress={cancelEditing}
              style={({ pressed }) => [styles.cancelButton, { borderColor: t.line, opacity: pressed || updateAppearance.isPending ? 0.55 : 1 }]}
            >
              <Text style={[styles.cancelLabel, { color: t.text }]}>Cancel</Text>
            </Pressable>
            <GoldButton
              label="Save appearance"
              onPress={save}
              disabled={!changed}
              busy={updateAppearance.isPending}
              style={styles.saveButton}
            />
          </View>
        </View>
      ) : (
        <View style={styles.summary}>
          <Ionicons name="contrast-outline" size={20} color={t.accent} />
          <Text style={[styles.summaryText, { color: t.text }]}>{appearanceLabel(saved)}</Text>
          {success ? (
            <Text accessibilityLiveRegion="polite" style={[styles.success, { color: t.accent }]}>{success}</Text>
          ) : null}
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
    paddingVertical: tokens.spacing.xs,
    borderWidth: 1,
    borderRadius: 8,
  },
  editLabel: {
    fontFamily: tokens.font.bold,
    fontSize: tokens.text.body,
  },
  statusRow: {
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
  actionText: {
    fontFamily: tokens.font.bold,
    fontSize: tokens.text.meta,
    paddingVertical: tokens.spacing.xs,
  },
  editor: {
    gap: tokens.spacing.md,
  },
  options: {
    gap: tokens.spacing.xs,
  },
  option: {
    flexDirection: "row",
    alignItems: "center",
    gap: tokens.spacing.md,
    minHeight: 48,
    paddingHorizontal: tokens.spacing.md,
    paddingVertical: tokens.spacing.sm,
    borderWidth: 1,
    borderRadius: 8,
  },
  radio: {
    width: 22,
    height: 22,
    flexShrink: 0,
    borderWidth: 2,
    borderRadius: 11,
    alignItems: "center",
    justifyContent: "center",
  },
  radioDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  optionCopy: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  optionLabel: {
    fontFamily: tokens.font.semibold,
    fontSize: tokens.text.body,
  },
  optionDescription: {
    fontFamily: tokens.font.regular,
    fontSize: tokens.text.meta,
    lineHeight: 19,
    flexShrink: 1,
  },
  actions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: tokens.spacing.sm,
  },
  cancelButton: {
    flexGrow: 1,
    flexBasis: 110,
    minHeight: 48,
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
    flexGrow: 2,
    flexBasis: 160,
  },
  summary: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: tokens.spacing.sm,
  },
  summaryText: {
    fontFamily: tokens.font.semibold,
    fontSize: tokens.text.body,
  },
  success: {
    flexBasis: "100%",
    fontFamily: tokens.font.semibold,
    fontSize: tokens.text.meta,
    lineHeight: 19,
  },
});