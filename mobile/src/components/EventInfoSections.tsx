/**
 * Submissions-page content sections (event lifecycle stage 1), styled in
 * the app's network language: gold eyebrow over a display title, gold-hairline
 * numbered facts (the web About grid), ghost-numeral checklist rows (the web
 * "4 Steps to Complete" ladder), and an accordion FAQ. Data comes off the
 * event entity — sections render only when the event carries them.
 */
import type { EventEntity } from "@niltv/types";
import { Ionicons } from "@expo/vector-icons";
import { useState } from "react";
import { Linking, StyleSheet, Text, View } from "react-native";

import { PressableScale } from "@/components/PressableScale";
import { hapticSelect } from "@/lib/haptics";
import { tokens } from "@/theme/tokens";
import { useTheme } from "@/theme/useTheme";

function Eyebrow({ label }: { label: string }) {
  const t = useTheme();
  return <Text style={[styles.eyebrow, { color: t.accent }]}>{label.toUpperCase()}</Text>;
}

/** "What is …" — title sentence + gold-hairline numbered facts. */
export function AboutSection({ about }: { about: NonNullable<EventEntity["about"]> }) {
  const t = useTheme();
  return (
    <View style={styles.block}>
      <Eyebrow label="About This Event" />
      <Text style={[styles.title, { color: t.text }]}>{about.title}</Text>
      {about.note ? <Text style={[styles.note, { color: t.subtext }]}>{about.note}</Text> : null}
      <View style={styles.facts}>
        {about.facts.map((fact, i) => (
          <View key={fact} style={[styles.fact, { borderTopColor: tokens.color.gold }]}>
            <Text style={[styles.factNum, { color: tokens.color.goldDeep }]}>
              {String(i + 1).padStart(2, "0")}
            </Text>
            <Text style={[styles.factCopy, { color: t.text }]}>{fact}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

/** "Your Checklist" — ghost-numeral required steps. */
export function ChecklistSection({
  checklist,
}: {
  checklist: NonNullable<EventEntity["checklist"]>;
}) {
  const t = useTheme();
  return (
    <View style={styles.block}>
      <Eyebrow label="Your Checklist" />
      <Text style={[styles.title, { color: t.text }]}>
        {checklist.length} Steps to Complete
      </Text>
      <Text style={[styles.note, { color: t.subtext }]}>
        All steps required. Entries that skip a step won&apos;t be considered.
      </Text>
      {checklist.map((step, i) => (
        <View key={step.title} style={[styles.step, { borderBottomColor: t.line }]}>
          <Text style={styles.stepGhost}>{String(i + 1).padStart(2, "0")}</Text>
          <View style={styles.stepBody}>
            <Text style={[styles.stepTitle, { color: t.text }]}>{step.title}</Text>
            <Text style={[styles.stepCopy, { color: t.subtext }]}>{step.copy}</Text>
          </View>
        </View>
      ))}
    </View>
  );
}

/** Contestant FAQ — single-open accordion, gold accent on the open row. */
export function FaqSection({ faq }: { faq: NonNullable<EventEntity["faq"]> }) {
  const t = useTheme();
  const [open, setOpen] = useState<string | null>(faq[0]?.q ?? null);
  return (
    <View style={styles.block}>
      <Eyebrow label="Frequently Asked Questions" />
      <Text style={[styles.title, { color: t.text }]}>Contestant Questions</Text>
      <View style={styles.faqList}>
        {faq.map((item) => {
          const isOpen = open === item.q;
          return (
            <PressableScale
              key={item.q}
              scaleTo={0.99}
              onPress={() => {
                hapticSelect();
                setOpen(isOpen ? null : item.q);
              }}
              accessibilityRole="button"
              accessibilityLabel={item.q}
              accessibilityState={{ expanded: isOpen }}
              style={[
                styles.faqItem,
                {
                  backgroundColor: t.surface,
                  borderColor: isOpen ? tokens.color.gold : t.line,
                },
              ]}
            >
              <View style={styles.faqHead}>
                <Text style={[styles.faqQ, { color: t.text }]}>{item.q}</Text>
                <View
                  style={[
                    styles.faqIcon,
                    { backgroundColor: isOpen ? tokens.color.gold : t.inset },
                  ]}
                >
                  <Ionicons
                    name={isOpen ? "remove" : "add"}
                    size={16}
                    color={isOpen ? "#1a1a1f" : t.accent}
                  />
                </View>
              </View>
              {isOpen ? <Text style={[styles.faqA, { color: t.subtext }]}>{item.a}</Text> : null}
            </PressableScale>
          );
        })}
      </View>
    </View>
  );
}

/** The Legal Notice link — on every event surface, per the web pages. */
export function LegalLink({ url }: { url: string }) {
  const t = useTheme();
  return (
    <PressableScale
      onPress={() => void Linking.openURL(url).catch(() => undefined)}
      accessibilityRole="link"
      accessibilityLabel="Read the Legal Notice to Contestants"
      hitSlop={8}
      style={styles.legal}
    >
      <Text style={[styles.legalText, { color: t.subtext }]}>
        Read the Legal Notice to Contestants →
      </Text>
    </PressableScale>
  );
}

const styles = StyleSheet.create({
  block: {
    marginTop: tokens.spacing.xl + tokens.spacing.sm,
  },
  eyebrow: {
    fontFamily: tokens.font.extrabold,
    fontSize: tokens.text.label,
    letterSpacing: 1.6,
  },
  title: {
    fontFamily: tokens.font.extrabold,
    fontSize: tokens.text.title,
    lineHeight: tokens.text.title + 5,
    marginTop: tokens.spacing.sm,
  },
  note: {
    fontFamily: tokens.font.regular,
    fontSize: tokens.text.meta,
    lineHeight: 19,
    marginTop: tokens.spacing.sm,
  },
  facts: {
    marginTop: tokens.spacing.lg,
    gap: tokens.spacing.lg,
  },
  fact: {
    borderTopWidth: 2,
    paddingTop: tokens.spacing.md,
  },
  factNum: {
    fontFamily: tokens.font.extrabold,
    fontSize: tokens.text.meta,
    letterSpacing: 2,
  },
  factCopy: {
    fontFamily: tokens.font.semibold,
    fontSize: tokens.text.body,
    lineHeight: 22,
    marginTop: 6,
  },
  step: {
    flexDirection: "row",
    gap: tokens.spacing.lg,
    alignItems: "center",
    paddingVertical: tokens.spacing.lg,
    borderBottomWidth: 1,
  },
  stepGhost: {
    fontFamily: tokens.font.extrabold,
    fontSize: 44,
    lineHeight: 48,
    color: "rgba(217,178,91,0.28)",
    width: 58,
  },
  stepBody: {
    flex: 1,
  },
  stepTitle: {
    fontFamily: tokens.font.bold,
    fontSize: tokens.text.body,
  },
  stepCopy: {
    fontFamily: tokens.font.regular,
    fontSize: tokens.text.meta,
    lineHeight: 19,
    marginTop: 4,
  },
  faqList: {
    marginTop: tokens.spacing.lg,
    gap: tokens.spacing.sm,
  },
  faqItem: {
    borderWidth: 1,
    borderRadius: tokens.radius,
    padding: tokens.spacing.lg,
  },
  faqHead: {
    flexDirection: "row",
    alignItems: "center",
    gap: tokens.spacing.md,
  },
  faqQ: {
    flex: 1,
    fontFamily: tokens.font.bold,
    fontSize: tokens.text.body,
  },
  faqIcon: {
    width: 28,
    height: 28,
    borderRadius: 6,
    alignItems: "center",
    justifyContent: "center",
  },
  faqA: {
    fontFamily: tokens.font.regular,
    fontSize: tokens.text.meta,
    lineHeight: 20,
    marginTop: tokens.spacing.md,
  },
  legal: {
    alignSelf: "center",
    marginTop: tokens.spacing.xl,
  },
  legalText: {
    fontFamily: tokens.font.semibold,
    fontSize: tokens.text.meta,
    textDecorationLine: "underline",
  },
});
