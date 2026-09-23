/**
 * Shared channel/ambassador star-toggle list (spec §5.7) — the body of both
 * the top-bar ★ picker and the signup interest step. Selection state lives in
 * the parent as a Set of "targetType#targetId" keys; conversion helpers keep
 * the contract's NotificationFollow shape at the edges.
 */
import type { NotificationFollow } from "@niltv/types";
import { Ionicons } from "@expo/vector-icons";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";

import { useAmbassadors, useChannels } from "@/api/hooks";
import { schoolMeta } from "@/lib/format";
import { tokens } from "@/theme/tokens";
import { useTheme } from "@/theme/useTheme";

export const targetKey = (follow: NotificationFollow): string =>
  `${follow.targetType}#${follow.targetId}`;

export function keysToFollows(keys: ReadonlySet<string>): NotificationFollow[] {
  return [...keys].map((key) => {
    const [targetType = "", ...rest] = key.split("#");
    return { targetType, targetId: rest.join("#") } as NotificationFollow;
  });
}

function TargetRow({
  label,
  meta,
  starred,
  onToggle,
}: {
  label: string;
  meta?: string;
  starred: boolean;
  onToggle: () => void;
}) {
  const t = useTheme();
  return (
    <Pressable
      onPress={onToggle}
      accessibilityRole="switch"
      accessibilityState={{ checked: starred }}
      accessibilityLabel={`Notify me when ${label} posts`}
      style={({ pressed }) => [
        styles.row,
        { borderColor: starred ? t.accent : t.line, backgroundColor: t.surface, opacity: pressed ? 0.7 : 1 },
      ]}
    >
      <View style={styles.rowText}>
        <Text numberOfLines={1} style={[styles.rowLabel, { color: t.text }]}>
          {label}
        </Text>
        {meta ? (
          <Text numberOfLines={1} style={[styles.rowMeta, { color: t.subtext }]}>
            {meta}
          </Text>
        ) : null}
      </View>
      <Ionicons
        name={starred ? "star" : "star-outline"}
        size={22}
        color={starred ? tokens.color.gold : t.subtext}
      />
    </Pressable>
  );
}

export function NotifTargetList({
  selected,
  onToggle,
}: {
  selected: ReadonlySet<string>;
  onToggle: (key: string) => void;
}) {
  const t = useTheme();
  const channels = useChannels();
  const ambassadors = useAmbassadors();

  return (
    <>
      <Text style={[styles.section, { color: t.subtext }]}>CHANNELS</Text>
      {(channels.data?.channels ?? []).map((channel) => {
        const key = `channel#${channel.id}`;
        return (
          <TargetRow
            key={key}
            label={channel.name}
            starred={selected.has(key)}
            onToggle={() => onToggle(key)}
          />
        );
      })}

      <Text style={[styles.section, { color: t.subtext }]}>AMBASSADORS</Text>
      {ambassadors.isPending ? <ActivityIndicator color={t.accent} /> : null}
      {(ambassadors.data?.profiles ?? []).map((profile) => {
        const key = `ambassador#${profile.id}`;
        return (
          <TargetRow
            key={key}
            label={profile.name}
            meta={schoolMeta(profile.school, profile.sport)}
            starred={selected.has(key)}
            onToggle={() => onToggle(key)}
          />
        );
      })}
    </>
  );
}

const styles = StyleSheet.create({
  section: {
    fontFamily: tokens.font.bold,
    fontSize: 12,
    letterSpacing: 1,
    marginTop: tokens.spacing.md,
    marginBottom: tokens.spacing.sm,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: tokens.spacing.md,
    borderWidth: 1,
    borderRadius: tokens.radius,
    paddingVertical: 12,
    paddingHorizontal: tokens.spacing.lg,
    marginBottom: tokens.spacing.sm,
  },
  rowText: {
    flex: 1,
  },
  rowLabel: {
    fontFamily: tokens.font.semibold,
    fontSize: 15,
  },
  rowMeta: {
    fontFamily: tokens.font.regular,
    fontSize: 12,
    marginTop: 2,
  },
});
