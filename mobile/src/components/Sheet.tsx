import type { PropsWithChildren } from "react";
import { KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { tokens } from "@/theme/tokens";
import { useTheme } from "@/theme/useTheme";

export interface SheetProps {
  visible: boolean;
  onClose: () => void;
  title?: string;
}

/** Modal bottom sheet with a grab handle — the demo's sheet pattern (auth, vote confirm). */
export function Sheet({ visible, onClose, title, children }: PropsWithChildren<SheetProps>) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      {/* Lifts the sheet above the keyboard so lower fields (e.g. the AuthSheet DOB) stay visible. */}
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        style={styles.backdrop}
      >
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Close"
        />
        <View
          style={[
            styles.sheet,
            {
              backgroundColor: t.surface,
              paddingBottom: Math.max(insets.bottom, tokens.spacing.lg) + tokens.spacing.sm,
            },
          ]}
        >
          <View style={[styles.handle, { backgroundColor: t.dark ? "#3d3d45" : tokens.color.line }]} />
          {title ? <Text style={[styles.title, { color: t.text }]}>{title}</Text> : null}
          {children}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    justifyContent: "flex-end",
    backgroundColor: "rgba(0,0,0,0.45)",
  },
  sheet: {
    borderTopLeftRadius: tokens.radius + 4,
    borderTopRightRadius: tokens.radius + 4,
    paddingHorizontal: tokens.spacing.xl,
    paddingTop: tokens.spacing.sm,
  },
  handle: {
    alignSelf: "center",
    width: 40,
    height: 4,
    borderRadius: 2,
    marginBottom: tokens.spacing.lg,
  },
  title: {
    fontFamily: tokens.font.extrabold,
    fontSize: 20,
    marginBottom: tokens.spacing.sm,
  },
});
