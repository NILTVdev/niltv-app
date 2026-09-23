/**
 * Push tap → route (design §3.2): notifications carry `data.url` with an
 * in-app path (`/video/{id}`, `/event/{id}`); a tap pushes that route. The
 * cold-start case comes from getLastNotificationResponseAsync; warm taps from
 * the response listener. Handled responses are remembered so a re-mounted
 * layout never re-navigates.
 */
import * as Notifications from "expo-notifications";
import { useRouter } from "expo-router";
import { useEffect } from "react";

import { track } from "@/telemetry";

let handledResponseDate: number | null = null;

export function PushDeepLinks() {
  const router = useRouter();

  useEffect(() => {
    const routeTo = (response: Notifications.NotificationResponse | null) => {
      if (!response || response.notification.date === handledResponseDate) return;
      handledResponseDate = response.notification.date;
      const url: unknown = response.notification.request.content.data?.["url"];
      // Only ever navigate to in-app paths — never external data from a payload.
      if (typeof url === "string" && url.startsWith("/")) {
        track("push_open", { url });
        router.push(url as never);
      }
    };

    Notifications.getLastNotificationResponseAsync()
      .then(routeTo)
      .catch(() => undefined);
    const subscription = Notifications.addNotificationResponseReceivedListener(routeTo);
    return () => subscription.remove();
  }, [router]);

  return null;
}
