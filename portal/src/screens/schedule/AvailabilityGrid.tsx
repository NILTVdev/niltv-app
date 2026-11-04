/** My usual week: 7 days by 4 blocks, saved with my time zone. */
import { DAY_BLOCK_LABELS, DAY_BLOCKS, WEEKDAYS } from "@niltv/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api, errorText } from "../../api";
import { slotKey, WEEKDAY_LABELS } from "../../lib/heat";
import { formatDateTime, zoneAbbr } from "../../lib/time";
import { qk } from "../../queries";
import { ErrorNote, Loading } from "../../ui/bits";
import { useMe } from "../../ui/me";
import { useToast } from "../../ui/Toast";

export const BLOCK_HELP = "Morning is before noon. Afternoon is noon to 5. Evening is 5 to 9. Late night is after 9.";

export function AvailabilityGrid() {
  const { zone } = useMe();
  const qc = useQueryClient();
  const toast = useToast();
  const saved = useQuery({ queryKey: qk.availability, queryFn: api.availability });
  const [slots, setSlots] = useState<Set<string> | null>(null);

  useEffect(() => {
    if (saved.data && slots === null) setSlots(new Set(saved.data.slots));
  }, [saved.data, slots]);

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

  const toggle = (key: string) =>
    setSlots((cur) => {
      const next = new Set(cur ?? []);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <div className="panel stack">
      <p className="note">
        Set your usual week once. Staff use everyone&apos;s availability to plan streams, games and shoots. Change it any
        time.
      </p>
      <div className="avail" role="group" aria-label="Your usual week">
        <span />
        {WEEKDAYS.map((d) => (
          <span key={d} className="h" aria-hidden="true">
            {WEEKDAY_LABELS[d]}
          </span>
        ))}
        {DAY_BLOCKS.map((b) => (
          <div key={b} style={{ display: "contents" }}>
            <span className="rl" aria-hidden="true">
              {DAY_BLOCK_LABELS[b]}
            </span>
            {WEEKDAYS.map((d) => {
              const key = slotKey(d, b);
              return (
                <button
                  key={key}
                  type="button"
                  className="cell"
                  aria-pressed={current.has(key)}
                  aria-label={`${WEEKDAY_LABELS[d]} ${DAY_BLOCK_LABELS[b].toLowerCase()}`}
                  onClick={() => toggle(key)}
                />
              );
            })}
          </div>
        ))}
      </div>
      <p className="meta">
        {BLOCK_HELP} Times are in your zone ({zoneAbbr(new Date(), zone)}).
      </p>
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
