import { Ionicons } from "@expo/vector-icons";
import Constants from "expo-constants";
import { useRouter } from "expo-router";
import { useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import {
  useDeleteAccount,
  useMe,
  useSetNotificationPreferences,
  useSetPushEnabled,
  useUpdateDisplayName,
} from "@/api/hooks";
import { requireAuth, useAuthStore } from "@/auth/store";
import { GoldButton } from "@/components/GoldButton";
import { PrivacyLink } from "@/components/PrivacyLink";
import { goBack } from "@/lib/navigation";
import { requestAndRegister } from "@/push";
import { track, useScreenView } from "@/telemetry";
import { tokens } from "@/theme/tokens";
import { useTheme } from "@/theme/useTheme";
import type { NotificationPreferences } from "@niltv/types";

function GuestProfile() {
  const t = useTheme();
  const openAuth = useAuthStore((s) => s.openAuth);
  return (
    <View style={styles.signedOut}>
      <View style={[styles.avatar, { backgroundColor: t.inset }]}>
        <Ionicons name="person" size={40} color={t.subtext} />
      </View>
      <Text style={[styles.title, styles.caps, { color: t.text }]}>Join NILTV</Text>
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
  const setNotificationPreferences = useSetNotificationPreferences();
  const deleteAccount = useDeleteAccount();
  const updateDisplayName = useUpdateDisplayName();
  const [editingName, setEditingName] = useState(false);
  const [displayNameDraft, setDisplayNameDraft] = useState("");
  const [saveMessage, setSaveMessage] = useState("");
  const [notificationPreferencesDraft, setNotificationPreferencesDraft] =
    useState<NotificationPreferences | null>(null);
  const [pushMessage, setPushMessage] = useState("");
  const [preferencesMessage, setPreferencesMessage] = useState("");
  const [registeringPush, setRegisteringPush] = useState(false);

  const name = me.data?.displayName || me.data?.name || storeName || "NILTV Fan";
  const email = me.data?.email || storeEmail || "";
  const initial = name.trim().charAt(0).toUpperCase() || "N";
  const normalizedDraft = displayNameDraft.trim();
  const displayNameUnchanged = normalizedDraft === name.trim();
  const followingLabel = me.data
    ? // Everything followable today is a channel (athlete accounts arrive with the roster).
      `Following ${me.data.follows.length} channel${me.data.follows.length === 1 ? "" : "s"}`
    : me.isError
      ? "Following. Can't reach NILTV right now"
      : "Following …";

  // Category preferences are independent from the global gate. Only a clear
  // opt-in gesture may enable the gate, after permission and registration.
  function togglePush(enabled: boolean) {
    setPushMessage("");
    if (!enabled) {
      setPushEnabled.mutate(false, {
        onSuccess: () => setPushMessage("Push notifications are off."),
        onError: () => setPushMessage("Could not update push settings. Please try again."),
      });
      return;
    }

    setRegisteringPush(true);
    void requestAndRegister()
      .then((permission) => {
        if (permission === "granted") {
          setPushMessage("Push notifications are on.");
        } else {
          setPushMessage("Push notifications were not enabled. Check device permission and try again.");
        }
      })
      .finally(() => setRegisteringPush(false));
  }

  const savedPreferences = me.data?.notificationPreferences;
  const preferences = notificationPreferencesDraft ?? savedPreferences;
  const preferencesChanged =
    !!preferences &&
    !!savedPreferences &&
    Object.keys(savedPreferences).some(
      (key) =>
        preferences[key as keyof NotificationPreferences] !==
        savedPreferences[key as keyof NotificationPreferences],
    );

  function toggleNotificationPreference(key: keyof NotificationPreferences, value: boolean) {
    if (!savedPreferences || setNotificationPreferences.isPending) return;
    setPreferencesMessage("");
    setNotificationPreferencesDraft((current) => ({
      ...(current ?? savedPreferences),
      [key]: value,
    }));
  }

  function cancelNotificationPreferenceEdits() {
    if (setNotificationPreferences.isPending) return;
    setNotificationPreferencesDraft(null);
    setPreferencesMessage("");
    setNotificationPreferences.reset();
  }

  function saveNotificationPreferences() {
    if (!preferences || !preferencesChanged || setNotificationPreferences.isPending) return;
    setPreferencesMessage("");
    setNotificationPreferences.mutate(
      { notificationPreferences: preferences },
      {
        onSuccess: () => {
          setNotificationPreferencesDraft(null);
          setPreferencesMessage("Notification preferences saved.");
        },
      },
    );
  }

  function startEditingName() {
    setDisplayNameDraft(name);
    setSaveMessage("");
    updateDisplayName.reset();
    setEditingName(true);
  }

  function cancelEditingName() {
    setEditingName(false);
    setDisplayNameDraft(name);
    setSaveMessage("");
    updateDisplayName.reset();
  }

  function saveDisplayName() {
    if (!me.data || updateDisplayName.isPending || displayNameUnchanged || !normalizedDraft) return;
    setSaveMessage("");
    updateDisplayName.mutate(
      { displayName: normalizedDraft },
      {
        onSuccess: () => {
          setDisplayNameDraft(normalizedDraft);
          setEditingName(false);
          setSaveMessage("Display name saved.");
        },
      },
    );
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
        {editingName ? (
          <>
            <TextInput
              accessibilityLabel="Display name"
              autoCapitalize="words"
              autoCorrect={false}
              editable={!updateDisplayName.isPending}
              maxLength={80}
              onChangeText={setDisplayNameDraft}
              onSubmitEditing={saveDisplayName}
              placeholder="Display name"
              placeholderTextColor={t.subtext}
              returnKeyType="done"
              style={[
                styles.displayNameInput,
                { backgroundColor: t.surface, borderColor: t.line, color: t.text },
              ]}
              value={displayNameDraft}
            />
            <View style={styles.nameActions}>
              <GoldButton
                label="Save"
                onPress={saveDisplayName}
                disabled={displayNameUnchanged || !normalizedDraft}
                busy={updateDisplayName.isPending}
                style={styles.nameSaveButton}
              />
              <Pressable
                accessibilityRole="button"
                disabled={updateDisplayName.isPending}
                onPress={cancelEditingName}
                style={({ pressed }) => [styles.cancelNameButton, { opacity: pressed ? 0.7 : 1 }]}
              >
                <Text style={[styles.cancelNameLabel, { color: t.subtext }]}>Cancel</Text>
              </Pressable>
            </View>
            {updateDisplayName.isError ? (
              <Text accessibilityRole="alert" style={styles.nameError}>
                {updateDisplayName.error.message || "Could not save your display name. Please try again."}
              </Text>
            ) : null}
          </>
        ) : (
          <>
            <Text style={[styles.title, { color: t.text }]}>{name}</Text>
            <Pressable
              accessibilityRole="button"
              disabled={!me.data}
              onPress={startEditingName}
              style={({ pressed }) => [styles.editNameButton, { opacity: pressed ? 0.7 : 1 }]}
            >
              <Text style={[styles.editNameLabel, { color: t.accent }]}>Edit display name</Text>
            </Pressable>
          </>
        )}
        {saveMessage ? (
          <Text accessibilityLiveRegion="polite" style={[styles.nameSuccess, { color: t.accent }]}>
            {saveMessage}
          </Text>
        ) : null}
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

      <View style={[styles.notificationCard, { borderColor: t.line, backgroundColor: t.surface }]}>
        <View style={styles.notificationHeading}>
          <Ionicons name="notifications-outline" size={18} color={t.accent} />
          <Text style={[styles.notificationTitle, { color: t.text }]}>Notifications</Text>
        </View>
        <View style={styles.globalPushRow}>
          <View style={styles.preferenceCopy}>
            <Text style={[styles.preferenceLabel, { color: t.text }]}>Allow push notifications</Text>
            <Text style={[styles.preferenceDescription, { color: t.subtext }]}>
              This global setting overrides every category below.
            </Text>
          </View>
          {me.isPending || registeringPush ? (
            <ActivityIndicator size="small" color={t.accent} />
          ) : (
            <Switch
              value={me.data?.pushEnabled === true}
              onValueChange={togglePush}
              disabled={me.data === undefined || setPushEnabled.isPending || registeringPush}
              trackColor={{ true: tokens.color.gold }}
              accessibilityRole="switch"
              accessibilityLabel="Allow push notifications"
              accessibilityState={{ checked: me.data?.pushEnabled === true }}
            />
          )}
        </View>
        {registeringPush ? (
          <Text accessibilityLiveRegion="polite" style={[styles.preferenceStatus, { color: t.subtext }]}>
            Waiting for device permission and registering this device…
          </Text>
        ) : pushMessage ? (
          <Text
            accessibilityLiveRegion="polite"
            accessibilityRole={pushMessage.startsWith("Could not") ? "alert" : undefined}
            style={[styles.preferenceStatus, { color: t.subtext }]}
          >
            {pushMessage}
          </Text>
        ) : null}
        <Text style={[styles.categoryIntro, { color: t.subtext }]}>
          Choose which types of push notifications you want. These choices do not turn push
          notifications on.
        </Text>
        {me.isPending ? (
          <ActivityIndicator size="small" color={t.accent} />
        ) : me.isError ? (
          <Text accessibilityRole="alert" style={styles.preferenceError}>
            Could not load notification preferences. Please try again.
          </Text>
        ) : preferences ? (
          <>
            <View style={[styles.categoryRow, { borderTopColor: t.line }]}>
              <View style={styles.preferenceCopy}>
                <Text style={[styles.preferenceLabel, { color: t.text }]}>
                  New videos from followed notification targets
                </Text>
                <Text style={[styles.preferenceDescription, { color: t.subtext }]}>
                  Channels you starred for notifications.
                </Text>
              </View>
              <Switch
                value={preferences.newVideosFromFollowedTargets}
                onValueChange={(value) =>
                  toggleNotificationPreference("newVideosFromFollowedTargets", value)
                }
                disabled={!savedPreferences || setNotificationPreferences.isPending}
                trackColor={{ true: tokens.color.gold }}
                accessibilityRole="switch"
                accessibilityLabel="New videos from followed notification targets"
                accessibilityState={{ checked: preferences.newVideosFromFollowedTargets }}
              />
            </View>
            <View style={[styles.categoryRow, { borderTopColor: t.line }]}>
              <View style={styles.preferenceCopy}>
                <Text style={[styles.preferenceLabel, { color: t.text }]}>
                  Competitions and voting
                </Text>
                <Text style={[styles.preferenceDescription, { color: t.subtext }]}>
                  Voting opens, closing reminders, and results.
                </Text>
              </View>
              <Switch
                value={preferences.competitionsAndVoting}
                onValueChange={(value) => toggleNotificationPreference("competitionsAndVoting", value)}
                disabled={!savedPreferences || setNotificationPreferences.isPending}
                trackColor={{ true: tokens.color.gold }}
                accessibilityRole="switch"
                accessibilityLabel="Competitions and voting"
                accessibilityState={{ checked: preferences.competitionsAndVoting }}
              />
            </View>
            <View style={[styles.categoryRow, { borderTopColor: t.line }]}>
              <View style={styles.preferenceCopy}>
                <Text style={[styles.preferenceLabel, { color: t.text }]}>NILTV announcements</Text>
                <Text style={[styles.preferenceDescription, { color: t.subtext }]}>
                  This category does not currently have an active fan notification source.
                </Text>
              </View>
              <Switch
                value={preferences.niltvAnnouncements}
                onValueChange={(value) => toggleNotificationPreference("niltvAnnouncements", value)}
                disabled={!savedPreferences || setNotificationPreferences.isPending}
                trackColor={{ true: tokens.color.gold }}
                accessibilityRole="switch"
                accessibilityLabel="NILTV announcements"
                accessibilityState={{ checked: preferences.niltvAnnouncements }}
              />
            </View>
            {setNotificationPreferences.isError ? (
              <Text accessibilityRole="alert" style={styles.preferenceError}>
                {setNotificationPreferences.error.message ||
                  "Could not save notification preferences. Please try again."}
              </Text>
            ) : null}
            {preferencesMessage ? (
              <Text accessibilityLiveRegion="polite" style={[styles.preferenceStatus, { color: t.accent }]}>
                {preferencesMessage}
              </Text>
            ) : null}
            {preferencesChanged || setNotificationPreferences.isPending ? (
              <View style={styles.preferenceActions}>
                <GoldButton
                  label="Save notification settings"
                  onPress={saveNotificationPreferences}
                  disabled={!preferencesChanged}
                  busy={setNotificationPreferences.isPending}
                  style={styles.preferenceSave}
                />
                <Pressable
                  accessibilityRole="button"
                  disabled={setNotificationPreferences.isPending}
                  onPress={cancelNotificationPreferenceEdits}
                  style={({ pressed }) => [styles.preferenceCancel, { opacity: pressed ? 0.7 : 1 }]}
                >
                  <Text style={[styles.cancelNameLabel, { color: t.subtext }]}>Cancel</Text>
                </Pressable>
              </View>
            ) : null}
          </>
        ) : null}
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

  // Pushed from the top bar's profile button (no Profile tab), so it carries
  // its own back chevron and the bottom inset the tab bar used to cover.
  return (
    <SafeAreaView edges={["top", "bottom"]} style={[styles.screen, { backgroundColor: t.bg }]}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.headerRow}>
          <Pressable onPress={() => goBack()} accessibilityRole="button" accessibilityLabel="Back" hitSlop={8}>
            <Ionicons name="chevron-back" size={26} color={t.text} />
          </Pressable>
          <Text style={[styles.heading, styles.caps, { color: t.text }]}>Profile</Text>
        </View>

        {status === "restoring" ? (
          <View style={styles.restoring}>
            <ActivityIndicator size="large" color={t.accent} />
          </View>
        ) : status === "signedIn" ? (
          <SignedInProfile />
        ) : (
          <GuestProfile />
        )}

        {/* Signed in or not: App Review looks for the policy inside the app. */}
        <PrivacyLink />
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
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: tokens.spacing.sm,
    paddingTop: tokens.spacing.md,
  },
  heading: {
    fontFamily: tokens.font.extrabold,
    fontSize: 26,
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
  displayNameInput: {
    alignSelf: "stretch",
    borderWidth: 1,
    borderRadius: tokens.radius,
    paddingHorizontal: tokens.spacing.md,
    paddingVertical: tokens.spacing.sm,
    fontFamily: tokens.font.regular,
    fontSize: tokens.text.body,
    textAlign: "center",
  },
  nameActions: {
    alignSelf: "stretch",
    gap: tokens.spacing.xs,
  },
  nameSaveButton: {
    alignSelf: "stretch",
  },
  cancelNameButton: {
    alignItems: "center",
    padding: tokens.spacing.sm,
  },
  cancelNameLabel: {
    fontFamily: tokens.font.semibold,
    fontSize: 14,
  },
  editNameButton: {
    padding: tokens.spacing.xs,
  },
  editNameLabel: {
    fontFamily: tokens.font.semibold,
    fontSize: 13,
  },
  nameError: {
    color: "#d97970",
    fontFamily: tokens.font.regular,
    fontSize: 13,
    textAlign: "center",
  },
  nameSuccess: {
    fontFamily: tokens.font.semibold,
    fontSize: 13,
    textAlign: "center",
  },
  // The page headings run in caps; the signed-in name (also styles.title)
  // keeps the user's own casing.
  caps: {
    textTransform: "uppercase",
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
  notificationCard: {
    borderWidth: 1,
    borderRadius: tokens.radius,
    padding: tokens.spacing.md,
    gap: tokens.spacing.sm,
  },
  notificationHeading: {
    flexDirection: "row",
    alignItems: "center",
    gap: tokens.spacing.sm,
  },
  notificationTitle: {
    fontFamily: tokens.font.bold,
    fontSize: tokens.text.section,
  },
  globalPushRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: tokens.spacing.sm,
    paddingVertical: tokens.spacing.xs,
  },
  categoryIntro: {
    fontFamily: tokens.font.regular,
    fontSize: tokens.text.meta,
    lineHeight: 19,
  },
  categoryRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: tokens.spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: tokens.spacing.sm,
    paddingBottom: tokens.spacing.xs,
  },
  preferenceCopy: {
    flex: 1,
    minWidth: 0,
    gap: tokens.spacing.xs,
  },
  preferenceLabel: {
    fontFamily: tokens.font.semibold,
    fontSize: tokens.text.body,
    lineHeight: 21,
  },
  preferenceDescription: {
    fontFamily: tokens.font.regular,
    fontSize: tokens.text.meta,
    lineHeight: 19,
  },
  preferenceStatus: {
    fontFamily: tokens.font.regular,
    fontSize: tokens.text.meta,
    lineHeight: 19,
  },
  preferenceError: {
    color: "#d97970",
    fontFamily: tokens.font.regular,
    fontSize: tokens.text.meta,
    lineHeight: 19,
  },
  preferenceActions: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "center",
    gap: tokens.spacing.sm,
    paddingTop: tokens.spacing.xs,
  },
  preferenceSave: {
    flexGrow: 1,
    flexBasis: 170,
  },
  preferenceCancel: {
    alignItems: "center",
    justifyContent: "center",
    minHeight: 44,
    paddingHorizontal: tokens.spacing.md,
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
