/**
 * The small card above the composer in desk threads that offers phone and
 * browser notifications. Never on first load or sign-in: athletes and
 * guests see it once they have written to a desk, staff when they open
 * one. Only while push is on, the stage has a key, this browser can
 * subscribe and has not been asked yet. "Not now" holds for 30 days.
 * iPhone and iPad in a browser tab get the Add to Home Screen card instead.
 */
import { useId, useState } from "react";
import { errorText } from "../../api";
import { promptSnoozed, snoozePrompt } from "../../lib/push";
import { useToast } from "../../ui/Toast";
import { usePush } from "../../ui/usePush";

export function PushPrompt({ staff }: { staff: boolean }) {
  const push = usePush();
  const toast = useToast();
  const headId = useId();
  const [hidden, setHidden] = useState(() => promptSnoozed());

  if (!push.enabled || hidden) return null;

  const snooze = () => {
    snoozePrompt();
    setHidden(true);
  };

  if (push.support === "ios-home-screen") {
    return (
      <div className="prime" role="group" aria-label="Notifications">
        <p className="note">Add the portal to your Home Screen to get notifications: tap Share, then Add to Home Screen.</p>
        <div className="row">
          <button type="button" className="btn ghost sm" onClick={snooze}>
            Got it
          </button>
        </div>
      </div>
    );
  }

  if (push.support !== "supported" || push.permission !== "default") return null;

  const turnOn = () => {
    push
      .turnOn()
      .then((result) => {
        if (result === "on") toast("Notifications are on for this browser.");
        // Closed without a choice: ask again in 30 days, not on the next thread.
        if (result === "dismissed") snooze();
      })
      .catch((err: unknown) => toast(errorText(err), "bad"));
  };

  return (
    <div className="prime" role="group" aria-labelledby={headId}>
      <div className="txt">
        <p className="t" id={headId}>
          {staff ? "Get a notification when someone writes to your desk" : "Get a notification when the team replies"}
        </p>
        <p className="note">You choose what reaches you in Account.</p>
      </div>
      <div className="row">
        <button type="button" className="btn sm" disabled={push.busy} onClick={turnOn}>
          Turn on
        </button>
        <button type="button" className="btn ghost sm" disabled={push.busy} onClick={snooze}>
          Not now
        </button>
      </div>
    </div>
  );
}
