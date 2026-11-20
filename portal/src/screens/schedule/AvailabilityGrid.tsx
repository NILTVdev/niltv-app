/** My usual week: 7 days in 30-minute rows, saved with my time zone. */
import { DAY_TIMES, WEEKDAYS, dayTimeLabel } from "@niltv/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type MouseEvent, type PointerEvent, useEffect, useRef, useState } from "react";
import { api, errorText } from "../../api";
import { copyDay, hourLabel, slotKey, WEEKDAY_LABELS } from "../../lib/heat";
import { formatDateTime } from "../../lib/time";
import { qk } from "../../queries";
import { ErrorNote, Loading } from "../../ui/bits";
import { useMe } from "../../ui/me";
import { useToast } from "../../ui/Toast";

export function AvailabilityGrid() {
  const { zone } = useMe();
  const qc = useQueryClient();
  const toast = useToast();
  const saved = useQuery({ queryKey: qk.availability, queryFn: api.availability });
  const [slots, setSlots] = useState<Set<string> | null>(null);
  /** the value a mouse drag is painting; null when no drag is on */
  const painting = useRef<boolean | null>(null);
  /** the click that ends a mouse press was already handled by the press */
  const pressed = useRef(false);

  useEffect(() => {
    if (saved.data && slots === null) setSlots(new Set(saved.data.slots));
  }, [saved.data, slots]);

  useEffect(() => {
    const stop = () => {
      painting.current = null;
    };
    window.addEventListener("pointerup", stop);
    return () => window.removeEventListener("pointerup", stop);
  }, []);

  const save = useMutation({
    mutationFn: () => api.saveAvailability({ slots: [...(slots ?? [])], timezone: zone }),
    onSuccess: (data) => {
      qc.setQueryData(qk.availability, data);
      toast("Availability saved.");
    },
  });

  if (saved.isPending) return <Loading />;
  if (saved.error) return <ErrorNote error={saved.error} onRetry={() => void saved.refetch()} />;
  const current = slots ?? new Set<string>();
  const dirty = saved.data ? !(current.size === saved.data.slots.length && saved.data.slots.every((s) => current.has(s))) : false;
  const mondaySet = [...current].some((s) => s.startsWith("mon-"));

  const paint = (key: string, on: boolean) =>
    setSlots((cur) => {
      const next = new Set(cur ?? []);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });

  // A mouse can drag across cells. Touch stays a tap, so a finger can still scroll the page.
  const press = (e: PointerEvent<HTMLButtonElement>, key: string) => {
    if (e.pointerType !== "mouse" || e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    pressed.current = true;
    painting.current = !current.has(key);
    paint(key, painting.current);
  };

  const click = (_: MouseEvent, key: string) => {
    if (pressed.current) {
      pressed.current = false;
      return;
    }
    paint(key, !current.has(key));
  };

  return (
    <div className="panel stack">
      <p className="note">
        Set your usual week once. Staff use everyone&apos;s availability to plan streams, games and shoots. Change it any
        time.
      </p>
      <div className="row">
        <button
          type="button"
          className="btn ghost sm"
          disabled={!mondaySet}
          onClick={() => setSlots(copyDay(current, "mon", ["tue", "wed", "thu", "fri"]))}
        >
          Copy Monday to weekdays
        </button>
      </div>
      <div className="avail" role="group" aria-label="Your usual week">
        <span className="h" />
        {WEEKDAYS.map((d) => (
          <span key={d} className="h" aria-hidden="true">
            {WEEKDAY_LABELS[d]}
          </span>
        ))}
        {DAY_TIMES.map((t) => (
          <div key={t} style={{ display: "contents" }}>
            <span className="rl" aria-hidden="true">
              {hourLabel(t)}
            </span>
            {WEEKDAYS.map((d) => {
              const key = slotKey(d, t);
              return (
                <button
                  key={key}
                  type="button"
                  className="cell"
                  aria-pressed={current.has(key)}
                  aria-label={`${WEEKDAY_LABELS[d]} ${dayTimeLabel(t)}`}
                  onPointerDown={(e) => press(e, key)}
                  onPointerEnter={() => {
                    if (painting.current !== null) paint(key, painting.current);
                  }}
                  onClick={(e) => click(e, key)}
                />
              );
            })}
          </div>
        ))}
      </div>
      {save.error ? (
        <p className="err" role="alert">
          {errorText(save.error)}
        </p>
      ) : null}
      <div className="row">
        <button type="button" className="btn" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? "Saving…" : "Save my week"}
        </button>
        <span className="note">
          {dirty
            ? "Not saved yet."
            : saved.data?.updatedAt
              ? `Last saved ${formatDateTime(saved.data.updatedAt, zone)}.`
              : "Not set yet."}
        </span>
      </div>
    </div>
  );
}
