/**
 * Newsletter signup — "The Playbook" (spec §5.6): free email/SMS capture,
 * modal-presented, reached from five tagged entry points (topbar, home band,
 * profile row, post-vote, recap — the `source` route param). POSTs to the
 * public /v1/newsletter endpoint; DynamoDB is the system of record (§6.7).
 * No intro reel on this screen (closing the modal would unmount it after the
 * player was released and blank the app), so the page is the title, the
 * copy, the benefits and the form. Keyboard-safe, one mechanism
 * per platform: on iOS the ScrollView adjusts its own insets for the keyboard
 * and scrolls the focused field into view (measured in window coordinates,
 * so it is exact inside the modal sheet); on Android a KeyboardAvoidingView
 * lifts it, the Sheet.tsx shape. Room below the button keeps the email and
 * phone fields visible while typing, and Next on the email keyboard moves
 * focus to the phone field.
 */
import { NewsletterSource } from "@niltv/types";
import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams } from "expo-router";
import { useRef, useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { useNewsletterSignup } from "@/api/hooks";
import { GoldButton } from "@/components/GoldButton";
import { goBack } from "@/lib/navigation";
import { useScreenView } from "@/telemetry";
import { tokens } from "@/theme/tokens";
import { useTheme } from "@/theme/useTheme";

/** Muted red for inline error copy (same as the auth sheet). */
const ERROR_RED = "#b04a3f";

const BENEFITS = [
  "Weekly athlete spotlights & top clips",
  "NIL STAR voting windows before anyone else",
  "Event results and winner drops the moment they land",
  "First looks at new campus channels",
];

export default function NewsletterScreen() {
  const t = useTheme();
  const params = useLocalSearchParams<{ source?: string }>();
  const parsedSource = NewsletterSource.safeParse(params.source);
  const source = parsedSource.success ? parsedSource.data : "topbar";
  useScreenView("newsletter", { source });

  const signup = useNewsletterSignup();
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [error, setError] = useState<string | null>(null);
  const phoneRef = useRef<TextInput>(null);

  function submit() {
    setError(null);
    if (!email.trim().includes("@")) {
      setError("Enter a valid email address.");
      return;
    }
    signup.mutate(
      {
        email: email.trim().toLowerCase(),
        ...(phone.trim() ? { phone: phone.trim() } : {}),
        source,
      },
      {
        onError: () => setError("Can't reach NILTV right now. Please try again."),
      },
    );
  }

  return (
    <SafeAreaView edges={["top"]} style={[styles.screen, { backgroundColor: t.bg }]}>
      {/* One keyboard mechanism per platform: iOS uses the ScrollView's
          own keyboard insets below, so this view is inert there (both at once
          lift the form twice); Android uses it as Sheet.tsx does. The
          content padding leaves room to scroll the phone field and button
          clear of the keyboard. */}
      <KeyboardAvoidingView
        behavior={Platform.OS === "android" ? "height" : undefined}
        style={styles.screen}
      >
        <ScrollView
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
          automaticallyAdjustKeyboardInsets={Platform.OS === "ios"}
        >
          <View style={styles.header}>
            <Pressable onPress={() => goBack()} accessibilityRole="button" accessibilityLabel="Close">
              <Ionicons name="close" size={26} color={t.text} />
            </Pressable>
          </View>

          <Text style={[styles.title, { color: t.text }]}>The Playbook</Text>
          <Text style={[styles.copy, { color: t.subtext }]}>
            The official NILTV newsletter. Inside the network, every week: the athletes,
            the campus channels, and the competitions. Free, straight to your inbox.
          </Text>

          {signup.isSuccess ? (
            <View style={[styles.done, { borderColor: t.accent, backgroundColor: t.surface }]}>
              <Ionicons name="checkmark-circle" size={22} color={t.accent} />
              <Text style={[styles.doneText, { color: t.text }]}>
                You&apos;re in! First issue lands soon.
              </Text>
            </View>
          ) : (
            <>
              {BENEFITS.map((benefit) => (
                <View key={benefit} style={styles.benefit}>
                  <Ionicons name="star" size={14} color={tokens.color.gold} />
                  <Text style={[styles.benefitText, { color: t.text }]}>{benefit}</Text>
                </View>
              ))}

              <TextInput
                style={[styles.input, { borderColor: t.line, color: t.text, backgroundColor: t.inset }]}
                placeholder="Email"
                accessibilityLabel="Email"
                placeholderTextColor={t.subtext}
                value={email}
                onChangeText={setEmail}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="email-address"
                textContentType="emailAddress"
                returnKeyType="next"
                submitBehavior="submit"
                onSubmitEditing={() => phoneRef.current?.focus()}
                editable={!signup.isPending}
              />
              <TextInput
                ref={phoneRef}
                style={[styles.input, { borderColor: t.line, color: t.text, backgroundColor: t.inset }]}
                placeholder="Phone (optional, for SMS drops)"
                accessibilityLabel="Phone number, optional, for SMS drops"
                placeholderTextColor={t.subtext}
                value={phone}
                onChangeText={setPhone}
                keyboardType="phone-pad"
                textContentType="telephoneNumber"
                returnKeyType="done"
                onSubmitEditing={submit}
                editable={!signup.isPending}
              />
              {error ? <Text style={styles.error}>{error}</Text> : null}
              <GoldButton
                label="Sign Me Up"
                onPress={submit}
                busy={signup.isPending}
                style={styles.submit}
              />
              <Text style={[styles.fine, { color: t.subtext }]}>
                Free forever. Unsubscribe anytime.
              </Text>
            </>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },
  content: {
    flexGrow: 1,
    paddingHorizontal: tokens.spacing.xl,
    // Room to scroll the phone field and button above the keyboard.
    paddingBottom: 120,
  },
  header: {
    flexDirection: "row",
    justifyContent: "flex-end",
    paddingVertical: tokens.spacing.md,
  },
  icon: {
    alignSelf: "center",
    marginBottom: tokens.spacing.sm,
  },
  title: {
    fontFamily: tokens.font.extrabold,
    fontSize: 26,
    lineHeight: 32,
    letterSpacing: 0.4,
    textAlign: "center",
    marginTop: tokens.spacing.lg,
  },
  copy: {
    fontFamily: tokens.font.regular,
    fontSize: 14,
    lineHeight: 21,
    textAlign: "center",
    marginTop: tokens.spacing.sm,
    marginBottom: tokens.spacing.xl,
  },
  benefit: {
    flexDirection: "row",
    alignItems: "center",
    gap: tokens.spacing.md,
    marginBottom: tokens.spacing.md,
  },
  benefitText: {
    flex: 1,
    fontFamily: tokens.font.semibold,
    fontSize: 14,
    lineHeight: 20,
  },
  input: {
    borderWidth: 1,
    borderRadius: 9,
    paddingVertical: 12,
    paddingHorizontal: 14,
    fontFamily: tokens.font.regular,
    fontSize: 15,
    marginTop: tokens.spacing.md,
  },
  error: {
    color: ERROR_RED,
    fontFamily: tokens.font.semibold,
    fontSize: 13,
    marginTop: tokens.spacing.md,
  },
  submit: {
    marginTop: tokens.spacing.lg,
  },
  done: {
    flexDirection: "row",
    alignItems: "center",
    gap: tokens.spacing.md,
    borderWidth: 1.5,
    borderRadius: tokens.radius,
    padding: tokens.spacing.lg,
    marginTop: tokens.spacing.lg,
  },
  doneText: {
    flex: 1,
    fontFamily: tokens.font.semibold,
    fontSize: 15,
  },
  fine: {
    fontFamily: tokens.font.regular,
    fontSize: 12,
    textAlign: "center",
    marginTop: tokens.spacing.md,
  },
});
