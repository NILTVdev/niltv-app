/**
 * Top-bar ★ notification picker (spec §5.7) — bottom sheet listing channels
 * and ambassadors with star toggles. Opens seeded from me.notificationFollows;
 * "Done" batch-replaces via PUT /v1/me/notification-follows and (with any
 * stars on) makes sure the device is actually registered for push. Event
 * "Notify me" opt-ins are preserved untouched — the picker only owns
 * channel/ambassador targets.
 */
import { useState } from "react";
import { ScrollView, StyleSheet, Text } from "react-native";

import { useMe, useSetNotificationFollows } from "@/api/hooks";
import { GoldButton } from "@/components/GoldButton";
import { NotifTargetList, keysToFollows, targetKey } from "@/components/NotifTargetList";
import { Sheet } from "@/components/Sheet";
import { requestAndRegister } from "@/push";
import { tokens } from "@/theme/tokens";
import { useTheme } from "@/theme/useTheme";

const PICKER_TYPES = new Set(["channel", "ambassador"]);

export function StarPicker({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const t = useTheme();
  const me = useMe();
  const setFollows = useSetNotificationFollows();

  // Selection derives from the server state until the user touches a star;
  // closing clears the overrides, so each open re-seeds — no reset effect.
  const [overrides, setOverrides] = useState<Set<string> | null>(null);
  const seeded = new Set(
    (me.data?.notificationFollows ?? [])
      .filter((f) => PICKER_TYPES.has(f.targetType))
      .map(targetKey),
  );
  const selected = overrides ?? seeded;

  const toggle = (key: string) =>
    setOverrides((prev) => {
      const next = new Set(prev ?? seeded);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  function close() {
    setOverrides(null);
    onClose();
  }

  function done() {
    // Preserve non-picker targets (event "Notify me" rows) verbatim.
    const kept = (me.data?.notificationFollows ?? []).filter((f) => !PICKER_TYPES.has(f.targetType));
    setFollows.mutate([...kept, ...keysToFollows(selected)]);
    const anyOn = selected.size > 0;
    close();
    if (anyOn) void requestAndRegister();
  }

  return (
    <Sheet visible={visible} onClose={close} title="Get notified">
      <Text style={[styles.copy, { color: t.subtext }]}>
        Star the channels and ambassadors you want a push from when they post.
      </Text>
      <ScrollView style={styles.list} showsVerticalScrollIndicator={false}>
        <NotifTargetList selected={selected} onToggle={toggle} />
      </ScrollView>
      <GoldButton label="Done" onPress={done} busy={setFollows.isPending} />
    </Sheet>
  );
}

const styles = StyleSheet.create({
  copy: {
    fontFamily: tokens.font.regular,
    fontSize: 13,
    lineHeight: 18,
    marginBottom: tokens.spacing.sm,
  },
  list: {
    maxHeight: 380,
    marginBottom: tokens.spacing.md,
  },
});
