/**
 * Signup interest step + push pre-prompt (design §6.2, spec §3.3's TODO made
 * real): shown once right after a FIRST sign-up. Step 1 is a skippable
 * multi-select seeding notification follows; step 2 is the soft pre-prompt —
 * only "Turn on alerts" triggers the OS permission dialog, so a "Not now"
 * never burns the one system prompt. Finishing (either way) resumes the
 * stashed gated action, e.g. the vote that opened the auth sheet.
 */
import { useState } from "react";
import { ScrollView, StyleSheet, Text } from "react-native";

import { useSetNotificationFollows } from "@/api/hooks";
import { useAuthStore } from "@/auth/store";
import { GoldButton } from "@/components/GoldButton";
import { NotifTargetList, keysToFollows } from "@/components/NotifTargetList";
import { Sheet } from "@/components/Sheet";
import { requestAndRegister } from "@/push";
import { track } from "@/telemetry";
import { tokens } from "@/theme/tokens";
import { useTheme } from "@/theme/useTheme";

type Step = "interests" | "push";

export function InterestSheet() {
  const t = useTheme();
  const interestOpen = useAuthStore((s) => s.interestOpen);
  const setFollows = useSetNotificationFollows();

  const [step, setStep] = useState<Step>("interests");
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const toggle = (key: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  /**
   * Close the sheet and resume whatever gated action started the signup.
   * Every close funnels through here, so resetting now (instead of a reset-
   * on-open effect) guarantees the next open starts fresh.
   */
  function finish() {
    setStep("interests");
    setSelected(new Set());
    const store = useAuthStore.getState();
    useAuthStore.setState({ interestOpen: false });
    store.runPendingAction();
  }

  function submitInterests(skipped: boolean) {
    if (!skipped && selected.size > 0) {
      setFollows.mutate(keysToFollows(selected));
    }
    track("signup_interests", { count: skipped ? 0 : selected.size, skipped });
    setStep("push");
  }

  async function enableAlerts() {
    await requestAndRegister();
    finish();
  }

  return (
    <Sheet visible={interestOpen} onClose={finish} title={step === "interests" ? "Who do you follow?" : "Never miss a drop"}>
      {step === "interests" ? (
        <>
          <Text style={[styles.copy, { color: t.subtext }]}>
            Pick your favorites and we&apos;ll tell you when they post. You can change this
            anytime from the ★ in the top bar.
          </Text>
          <ScrollView style={styles.list} showsVerticalScrollIndicator={false}>
            <NotifTargetList selected={selected} onToggle={toggle} />
          </ScrollView>
          <GoldButton
            label={selected.size > 0 ? `Continue (${selected.size})` : "Continue"}
            onPress={() => submitInterests(false)}
            busy={setFollows.isPending}
          />
          <Text
            onPress={() => submitInterests(true)}
            accessibilityRole="button"
            style={[styles.skip, { color: t.subtext }]}
          >
            Skip for now
          </Text>
        </>
      ) : (
        <>
          <Text style={[styles.copy, { color: t.subtext }]}>
            Voting windows, results, and new drops from your picks — a push when it matters,
            nothing more. You&apos;re in control from Profile.
          </Text>
          <GoldButton label="Turn on alerts" onPress={() => void enableAlerts()} />
          <Text onPress={finish} accessibilityRole="button" style={[styles.skip, { color: t.subtext }]}>
            Not now
          </Text>
        </>
      )}
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
    maxHeight: 340,
    marginBottom: tokens.spacing.md,
  },
  skip: {
    fontFamily: tokens.font.bold,
    fontSize: 14,
    textAlign: "center",
    paddingVertical: tokens.spacing.md,
  },
});
