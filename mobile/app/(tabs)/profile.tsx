import { Ionicons } from "@expo/vector-icons";
import Constants from "expo-constants";
import { useRouter } from "expo-router";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { useDeleteAccount, useMe, useSetPushEnabled } from "@/api/hooks";
import { requireAuth, useAuthStore } from "@/auth/store";
import { GoldButton } from "@/components/GoldButton";
import { requestAndRegister } from "@/push";
import { track, useScreenView } from "@/telemetry";
import { tokens } from "@/theme/tokens";
import { useTheme } from "@/theme/useTheme";

function GuestProfile() {
  const t = useTheme();
  const openAuth = useAuthStore((s) => s.openAuth);
  return (
    <View style={styles.signedOut}>
      <View style={[styles.avatar, { backgroundColor: t.inset }]}>
        <Ionicons name="person" size={40} color={t.subtext} />
      </View>
      <Text style={[styles.title, { color: t.text }]}>Join NILTV</Text>
      <Text style={[styles.copy, { color: t.subtext }]}>
        Vote in NIL STAR, follow your favorite athletes, and get notified when new drops
        land. Free, forever.
      </Text>
      {/* Gated-action pattern §3.3 — signing up IS the action here, so a no-op resumes. */}
      <GoldButton label="Sign Up Free" onPress={() => requireAuth(() => {})} />
      <Pressable onPress={() => openAuth("signIn")} accessibilityRole="button">
        <Text style={[styles.logIn, { color: t.accent }]}>Log In</Text>
      </Pressable>
    </View>
  );
}

/** Pressable settings row — icon, label, chevron. */
function Row({
  icon,
  label,
  danger,
  onPress,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  danger?: boolean;
  onPress: () => void;
}) {
  const t = useTheme();
  const color = danger ? "#b04a3f" : t.text;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => [
        styles.rowItem,
        { borderColor: t.line, backgroundColor: t.surface, opacity: pressed ? 0.7 : 1 },
      ]}
    >
      <Ionicons name={icon} size={18} color={danger ? color : t.subtext} />
      <Text style={[styles.rowLabel, { color }]}>{label}</Text>
      <Ionicons name="chevron-forward" size={16} color={t.subtext} />
    </Pressable>
  );
}

function SignedInProfile() {
  const t = useTheme();
  const router = useRouter();
  const storeName = useAuthStore((s) => s.name);
  const storeEmail = useAuthStore((s) => s.email);
  const signOutAction = useAuthStore((s) => s.signOutAction);
  const me = useMe();
  const setPushEnabled = useSetPushEnabled();
  const deleteAccount = useDeleteAccount();

  const name = me.data?.name || storeName || "NILTV Fan";
  const email = me.data?.email || storeEmail || "";
  const initial = name.trim().charAt(0).toUpperCase() || "N";
  const followingLabel = me.data
    ? // Everything followable today is a channel (athlete accounts arrive with the roster).
      `Following ${me.data.follows.length} channel${me.data.follows.length === 1 ? "" : "s"}`
    : me.isError
      ? "Following. Can't reach NILTV right now"
      : "Following …";

  // Global push toggle (design §7: mute keeps tokens, fanout checks the flag).
  // Turning ON also (re)runs permission + registration so the flag is honest.
  function togglePush(enabled: boolean) {
    setPushEnabled.mutate(enabled);
    if (enabled) void requestAndRegister();
  }

  // Two-step destructive confirm (App Store 5.1.1(v), design §6.6).
  function confirmDelete() {
    Alert.alert(
      "Delete your account?",
      "This permanently removes your profile, follows and notification settings. " +
        "Votes you've cast stay in contest tallies, anonymized, per the Official Rules.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete account",
          style: "destructive",
          onPress: () =>
            deleteAccount.mutate(undefined, {
              onSuccess: () => void signOutAction(),
              onError: () =>
                Alert.alert("Something went wrong", "Your account was not deleted. Please try again."),
            }),
        },
      ],
    );
  }

  return (
    <View style={styles.signedIn}>
      <View style={styles.header}>
        <View style={[styles.avatar, { backgroundColor: tokens.color.gold }]}>
          <Text style={styles.avatarInitial}>{initial}</Text>
        </View>
        <Text style={[styles.title, { color: t.text }]}>{name}</Text>
        {email ? <Text style={[styles.copy, { color: t.subtext }]}>{email}</Text> : null}
      </View>

      {/* Tap-through to manage follows. */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={followingLabel}
        onPress={() => router.push("/following")}
        style={({ pressed }) => [
          styles.rowItem,
          { borderColor: t.line, backgroundColor: t.surface, opacity: pressed ? 0.8 : 1 },
        ]}
      >
        <Ionicons name="people" size={18} color={t.accent} />
        <Text style={[styles.rowLabel, { color: t.text }]}>{followingLabel}</Text>
        {me.isPending ? (
          <ActivityIndicator size="small" color={t.accent} />
        ) : (
          <Ionicons name="chevron-forward" size={18} color={t.subtext} />
        )}
      </Pressable>

      <View style={[styles.rowItem, { borderColor: t.line, backgroundColor: t.surface }]}>
        <Ionicons name="notifications-outline" size={18} color={t.subtext} />
        <Text style={[styles.rowLabel, { color: t.text }]}>Push notifications</Text>
        <Switch
          value={me.data?.pushEnabled === true}
          onValueChange={togglePush}
          disabled={me.data === undefined}
          trackColor={{ true: tokens.color.gold }}
          accessibilityLabel="Push notifications"
        />
      </View>

      <Row
        icon="mail-outline"
        label="Get The Playbook newsletter"
        onPress={() => {
          track("newsletter_band_tap", { source: "profile" });
          router.push({ pathname: "/newsletter", params: { source: "profile" } });
        }}
      />

      {/* Official Rules row returns once the rules page exists on niltv.com
          (required before any vote opens and before App Review).
          No vote is scheduled. */}
      <Row icon="log-out-outline" label="Sign out" onPress={() => void signOutAction()} />

      <Row icon="trash-outline" label="Delete account" danger onPress={confirmDelete} />
      {deleteAccount.isPending ? <ActivityIndicator size="small" color={t.accent} /> : null}
    </View>
  );
}

export default function ProfileScreen() {
  const t = useTheme();
  const status = useAuthStore((s) => s.status);
  useScreenView("profile");

  return (
    <SafeAreaView edges={["top"]} style={[styles.screen, { backgroundColor: t.bg }]}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={[styles.heading, { color: t.text }]}>Profile</Text>

        {status === "restoring" ? (
          <View style={styles.restoring}>
            <ActivityIndicator size="large" color={t.accent} />
          </View>
        ) : status === "signedIn" ? (
          <SignedInProfile />
        ) : (
          <GuestProfile />
        )}

        <Text style={[styles.version, { color: t.subtext }]}>
          {`NILTV ${Constants.expoConfig?.version}`}
        </Text>
      </ScrollView>
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
    paddingBottom: tokens.spacing.xl,
  },
  heading: {
    fontFamily: tokens.font.extrabold,
    fontSize: 26,
    paddingTop: tokens.spacing.md,
  },
  restoring: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: tokens.spacing.xl * 2,
  },
  signedOut: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: tokens.spacing.md,
    paddingVertical: tokens.spacing.xl,
  },
  signedIn: {
    flex: 1,
    paddingVertical: tokens.spacing.xl,
    gap: tokens.spacing.md,
  },
  header: {
    alignItems: "center",
    gap: tokens.spacing.xs,
    marginBottom: tokens.spacing.lg,
  },
  avatar: {
    width: 88,
    height: 88,
    borderRadius: 44,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: tokens.spacing.xs,
  },
  avatarInitial: {
    color: "#1a1a1f",
    fontFamily: tokens.font.extrabold,
    fontSize: 36,
  },
  title: {
    fontFamily: tokens.font.extrabold,
    fontSize: 22,
  },
  copy: {
    fontFamily: tokens.font.regular,
    fontSize: 14,
    lineHeight: 20,
    textAlign: "center",
  },
  rowItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: tokens.spacing.md,
    borderWidth: 1,
    borderRadius: tokens.radius,
    paddingVertical: 14,
    paddingHorizontal: tokens.spacing.lg,
  },
  rowLabel: {
    flex: 1,
    fontFamily: tokens.font.semibold,
    fontSize: 15,
  },
  logIn: {
    fontFamily: tokens.font.bold,
    fontSize: 14,
    padding: tokens.spacing.sm,
  },
  version: {
    fontFamily: tokens.font.regular,
    fontSize: 12,
    textAlign: "center",
  },
});
