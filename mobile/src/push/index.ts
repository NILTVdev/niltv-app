/**
 * Push registration (design §6.2 tail, §7): permission → Expo push token →
 * POST /v1/me/devices. The OS dialog is only ever triggered from an explicit
 * user gesture (the soft pre-prompt's "Turn on alerts" or the Profile
 * toggle) — never on launch. Everything soft-fails: simulators, Expo Go
 * (no remote push since SDK 53) and a missing EAS projectId all just report
 * "unavailable" and the app carries on.
 */
import Constants from "expo-constants";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";

import { AckResponse } from "@niltv/types";

import { request } from "@/api/client";
import { track } from "@/telemetry";

// Foreground presentation: banner + list, no badge count at MVP.
Notifications.setNotificationHandler({
  handleNotification: () =>
    Promise.resolve({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: false,
      shouldSetBadge: false,
    }),
});

export type PushPermission = "granted" | "denied" | "undetermined" | "unavailable";

/** Current OS-level permission, mapped to the three states the UI cares about. */
export async function getPushPermission(): Promise<PushPermission> {
  if (!Device.isDevice) return "unavailable";
  try {
    const current = await Notifications.getPermissionsAsync();
    if (current.granted) return "granted";
    return current.canAskAgain ? "undetermined" : "denied";
  } catch {
    return "unavailable";
  }
}

/**
 * Request OS permission (shows the system dialog when undetermined), then
 * register the device token with the backend. Returns the resulting state —
 * "granted" only when the token actually reached the API.
 */
export async function requestAndRegister(): Promise<PushPermission> {
  if (!Device.isDevice) return "unavailable";
  try {
    let permission = await Notifications.getPermissionsAsync();
    if (!permission.granted && permission.canAskAgain) {
      permission = await Notifications.requestPermissionsAsync();
    }
    if (!permission.granted) {
      track("push_permission_denied");
      return permission.canAskAgain ? "undetermined" : "denied";
    }
    const registered = await registerToken();
    track(registered ? "push_registered" : "push_register_failed");
    return registered ? "granted" : "unavailable";
  } catch {
    return "unavailable";
  }
}

/**
 * Re-upload the token silently when permission is already granted (app start
 * while signed in) — tokens rotate across reinstalls, and re-registration is
 * an idempotent upsert server-side.
 */
export async function refreshRegistrationIfGranted(): Promise<void> {
  if ((await getPushPermission()) !== "granted") return;
  await registerToken().catch(() => undefined);
}

async function registerToken(): Promise<boolean> {
  // Remote push needs an EAS projectId (dev/prod builds carry one via
  // app.json extra.eas; Expo Go and bare simulators do not).
  const projectId: unknown =
    Constants.expoConfig?.extra?.["eas"]?.["projectId"] ?? Constants.easConfig?.projectId;
  if (typeof projectId !== "string" || projectId.length === 0) return false;

  const token = await Notifications.getExpoPushTokenAsync({ projectId });
  await request("/v1/me/devices", AckResponse, {
    method: "POST",
    auth: true,
    body: {
      expoPushToken: token.data,
      platform: Platform.OS === "android" ? "android" : "ios",
    },
  });
  return true;
}
