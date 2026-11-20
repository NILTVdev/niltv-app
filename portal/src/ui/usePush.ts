/**
 * This browser's web push, for Account and the prompt card: what it
 * supports, the permission, whether it is subscribed, and turning it on or
 * off. Inert unless the admin push switch is on and the stage has a VAPID
 * key. `usePushSetup` runs once in the shell: it registers the worker and
 * resyncs an existing subscription, and nothing else happens on load.
 */
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";
import { api, isApiError, PortalApiError } from "../api";
import {
  browserSupport,
  currentSubscription,
  notificationPermission,
  onWorkerNavigate,
  type PushSupport,
  rememberDevice,
  resyncSubscription,
  subscribeBrowser,
  subscriptionBody,
  thisDeviceId,
  thisDeviceLabel,
  unsubscribeBrowser,
  workerRegistration,
} from "../lib/push";
import { navigate } from "../lib/router";
import { useVisible } from "../lib/useVisible";
import { qk } from "../queries";
import { useMe } from "./me";

/** on = subscribed; denied = blocked in the prompt; dismissed = closed without a choice */
export type TurnOnResult = "on" | "denied" | "dismissed";

const COULD_NOT = "Could not turn on notifications in this browser. Try again.";

/** The VAPID key when push is on for this stage, else undefined. */
function useVapidKey(): string | undefined {
  const { notifications } = useMe();
  return notifications.webPush ? notifications.vapidPublicKey : undefined;
}

export function usePush() {
  const vapidKey = useVapidKey();
  const qc = useQueryClient();
  const visible = useVisible();
  const [support] = useState<PushSupport>(browserSupport);
  const [permission, setPermission] = useState(notificationPermission);
  /** undefined while checking */
  const [subscribed, setSubscribed] = useState<boolean | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const enabled = vapidKey !== undefined;

  // Read again whenever the tab comes back: the permission may have changed in browser settings.
  useEffect(() => {
    if (!enabled || support !== "supported" || !visible) return;
    let live = true;
    setPermission(notificationPermission());
    currentSubscription()
      .then((sub) => {
        if (live) setSubscribed(sub !== null);
      })
      .catch(() => {
        if (live) setSubscribed(false);
      });
    return () => {
      live = false;
    };
  }, [enabled, support, visible]);

  /** Call straight from a click: Safari only shows the permission prompt for a user gesture. */
  const turnOn = useCallback(async (): Promise<TurnOnResult> => {
    if (!vapidKey || support !== "supported") return "dismissed";
    setBusy(true);
    try {
      const result = await Notification.requestPermission();
      setPermission(result);
      if (result !== "granted") return result === "denied" ? "denied" : "dismissed";
      let sub: PushSubscription;
      try {
        sub = await subscribeBrowser(vapidKey);
      } catch {
        throw new Error(COULD_NOT);
      }
      const body = subscriptionBody(sub, thisDeviceLabel());
      try {
        if (!body) throw new Error(COULD_NOT);
        rememberDevice((await api.subscribePush(body)).id);
      } catch (err) {
        // The server did not keep it: do not leave a subscription nobody sends to.
        await sub.unsubscribe().catch(() => false);
        if (isApiError(err) && err.status === 409) throw new Error("Phone and browser notifications are off for now.");
        throw err instanceof PortalApiError ? err : new Error(COULD_NOT);
      }
      setSubscribed(true);
      void qc.invalidateQueries({ queryKey: qk.pushDevices });
      return "on";
    } finally {
      setBusy(false);
    }
  }, [vapidKey, support, qc]);

  /** This browser stops at once; the server copy goes too (a dead endpoint is dropped on the next send anyway). */
  const turnOff = useCallback(async (): Promise<void> => {
    setBusy(true);
    try {
      const endpoint = await unsubscribeBrowser().catch(() => undefined);
      setSubscribed(false);
      rememberDevice(null);
      if (endpoint) await api.removePush({ endpoint }).catch(() => undefined);
      void qc.invalidateQueries({ queryKey: qk.pushDevices });
    } finally {
      setBusy(false);
    }
  }, [qc]);

  /** Remove a listed device. When it is this browser, unsubscribe here too. */
  const removeDevice = useCallback(
    async (id: string): Promise<void> => {
      await api.removePush({ id });
      if (id === thisDeviceId()) {
        await unsubscribeBrowser().catch(() => undefined);
        rememberDevice(null);
        setSubscribed(false);
      }
      void qc.invalidateQueries({ queryKey: qk.pushDevices });
    },
    [qc],
  );

  return { enabled, support, permission, subscribed, busy, turnOn, turnOff, removeDevice };
}

/** Once in the shell: register the worker, resync once per session, follow notification clicks. */
export function usePushSetup(): void {
  const vapidKey = useVapidKey();
  useEffect(() => {
    if (!vapidKey || browserSupport() !== "supported") return;
    const stop = onWorkerNavigate((path) => navigate(path));
    void workerRegistration()
      .then(() => resyncSubscription(vapidKey, (body) => api.subscribePush(body)))
      .catch(() => {
        /* no worker this time: Account shows the state when someone looks */
      });
    return stop;
  }, [vapidKey]);
}
