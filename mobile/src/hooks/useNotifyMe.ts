/**
 * Upcoming-event "Notify me" (design §7): stored as a NotifFollow with
 * target_type "event" — the → live broadcast covers it. Gated action §3.3:
 * guests get the auth sheet first, then the tap resumes. Also nudges device
 * registration so the promise can actually be kept.
 */
import { useSetNotificationFollows } from "@/api/hooks";
import { queryKeys } from "@/api/keys";
import { queryClient } from "@/api/queryClient";
import { requireAuth } from "@/auth/store";
import { requestAndRegister } from "@/push";
import type { MeResponse } from "@niltv/types";

export function useNotifyMe(): (eventId: string, onDone: () => void) => void {
  const setFollows = useSetNotificationFollows();

  return (eventId, onDone) => {
    requireAuth(() => {
      const me = queryClient.getQueryData<MeResponse>(queryKeys.me);
      const existing = me?.notificationFollows ?? [];
      const already = existing.some((f) => f.targetType === "event" && f.targetId === eventId);
      if (!already) {
        setFollows.mutate([...existing, { targetType: "event", targetId: eventId }]);
      }
      onDone();
      void requestAndRegister();
    });
  };
}
