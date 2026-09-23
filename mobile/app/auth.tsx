/**
 * Full-screen auth (a real sign-up flow, not a sheet):
 * NILTV mark, the site's tagline, the network marquee as a band, the
 * sentence, then the email forms. Modal-presented;
 * backing out drops any stashed gated action (store.closeAuth).
 *
 * Keyboard-safe: the keyboard must never cover the sign-up fields. One
 * mechanism per platform, as newsletter.tsx: iOS
 * uses the ScrollView's own keyboard insets (exact inside the modal sheet),
 * Android a KeyboardAvoidingView (edge-to-edge, so the window no longer
 * resizes for the keyboard by itself). On top of that, while the keyboard is
 * up the list scrolls the form title to the top of what is left, so name,
 * email and Continue all sit clear of the keyboard, not just the field being
 * typed in.
 */
import { Ionicons } from "@expo/vector-icons";
import { useCallback, useEffect, useRef } from "react";
import {
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { useAuthStore } from "@/auth/store";
import { AuthForms } from "@/components/AuthForms";
import { NiltvLogo } from "@/components/Brand";
import { NetworkMarquee } from "@/components/NetworkMarquee";
import { goBack } from "@/lib/navigation";
import { useScreenView } from "@/telemetry";
import { tokens } from "@/theme/tokens";
import { useTheme } from "@/theme/useTheme";

export default function AuthScreen() {
  const t = useTheme();
  useScreenView("auth");

  const scroll = useRef<ScrollView>(null);
  // The form block's offset inside the scroll content (its wrapper's layout).
  const formTop = useRef(0);
  const keyboardUp = useRef(false);
  // Scroll the form title to the top edge; the list clamps to its own end,
  // so on a short step this simply shows the whole form above the keyboard.
  const revealForm = useCallback(() => {
    scroll.current?.scrollTo({ y: Math.max(formTop.current - tokens.spacing.sm, 0), animated: true });
  }, []);
  useEffect(() => {
    const show = Keyboard.addListener("keyboardDidShow", () => {
      keyboardUp.current = true;
      revealForm();
    });
    const hide = Keyboard.addListener("keyboardDidHide", () => {
      keyboardUp.current = false;
    });
    return () => {
      show.remove();
      hide.remove();
    };
  }, [revealForm]);

  return (
    <SafeAreaView edges={["top", "bottom"]} style={[styles.screen, { backgroundColor: t.bg }]}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "android" ? "height" : undefined}
        style={styles.screen}
      >
        <ScrollView
          ref={scroll}
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
          automaticallyAdjustKeyboardInsets={Platform.OS === "ios"}
          // Android: the avoiding view shrinks this list after the keyboard
          // event, and the scroll range only exists once it has; iOS keeps
          // its size and the keyboard event alone is enough.
          onLayout={() => {
            if (keyboardUp.current) revealForm();
          }}
        >
          <View style={styles.header}>
            <Pressable
              onPress={() => {
                useAuthStore.getState().closeAuth();
                goBack();
              }}
              accessibilityRole="button"
              accessibilityLabel="Close"
              hitSlop={8}
            >
              <Ionicons name="close" size={26} color={t.text} />
            </Pressable>
          </View>

          <NiltvLogo height={36} style={styles.logo} />
          {/* The site's tagline (the hero eyebrow voice: gold, tracked, uppercase). */}
          <Text numberOfLines={1} adjustsFontSizeToFit style={styles.tagline}>
            Real Name. Real Game. Real TV.
          </Text>
          {/* Full bleed: escapes the screen's xl side padding. Decorative, no
              touches (the component sets pointerEvents none), capped at its
              compact height so the form title stays above the fold on a 667pt
              phone. */}
          <View style={styles.band}>
            <NetworkMarquee variant="compact" />
          </View>
          <Text style={[styles.lede, { color: t.subtext }]}>
            The home of NIL content. Follow athletes, watch the network, vote in the competitions.
          </Text>

          <View
            onLayout={(e: LayoutChangeEvent) => {
              formTop.current = e.nativeEvent.layout.y;
            }}
          >
            <AuthForms />
          </View>
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
    paddingBottom: tokens.spacing.xl * 2,
  },
  header: {
    flexDirection: "row",
    justifyContent: "flex-end",
    paddingVertical: tokens.spacing.md,
  },
  logo: {
    alignSelf: "center",
    marginTop: tokens.spacing.sm,
  },
  tagline: {
    color: tokens.color.gold,
    fontFamily: tokens.font.displayBold,
    fontSize: 15,
    letterSpacing: 3.6,
    textAlign: "center",
    textTransform: "uppercase",
    marginTop: tokens.spacing.md,
  },
  band: {
    marginHorizontal: -tokens.spacing.xl,
    marginTop: tokens.spacing.sm,
  },
  lede: {
    fontFamily: tokens.font.regular,
    fontSize: 14,
    lineHeight: 20,
    textAlign: "center",
    marginTop: tokens.spacing.xs,
    marginBottom: tokens.spacing.lg,
  },
});
