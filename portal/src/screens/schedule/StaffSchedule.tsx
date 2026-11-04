/** Staff: every event with votes and replies, the event form, and the availability heatmap. */
import type { PortalEvent, RsvpStatus } from "@niltv/types";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { api, errorText } from "../../api";
import { byStart, isPast } from "../../lib/events";
import { plural, RSVP_LABELS } from "../../lib/format";
import { formatRange } from "../../lib/time";
import { qk, useEvents } from "../../queries";
import { Empty, ErrorNote, Loading, PageHead, Tabs } from "../../ui/bits";
import { useMe } from "../../ui/me";
import { useToast } from "../../ui/Toast";
import { useFlash } from "../../ui/useFlash";
import { EventForm } from "./EventForm";
import { Heatmap } from "./Heatmap";
import { EventFacts, EventTop, patchEvent, SetTime } from "./shared";

type Tab = "events" | "form" | "avail";

export function StaffSchedule({ id }: { id?: string }) {
  const { can } = useMe();
  const events = useEvents();
  const [tab, setTab] = useState<Tab>("events");
  const [editing, setEditing] = useState<PortalEvent | undefined>(undefined);

  const all = events.data ?? [];
  const polls = all.filter((e) => e.status === "poll").sort(byStart);
  const set = all.filter((e) => e.status === "set" && !isPast(e)).sort(byStart);
  const cancelled = all.filter((e) => e.status === "cancelled").sort(byStart);
  const past = all.filter((e) => e.status === "set" && isPast(e)).sort((a, b) => byStart(b, a));
  const target = id ? all.find((e) => e.id === id) : undefined;

  const routed = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (target && routed.current !== target.id) {
      routed.current = target.id;
      setTab("events");
    }
  }, [target]);
  useFlash(target && tab === "events" ? `event-${target.id}` : undefined, Boolean(target));

  const startEdit = (e: PortalEvent) => {
    setEditing(e);
    setTab("form");
    window.scrollTo({ top: 0 });
  };
  const closeForm = () => {
    setEditing(undefined);
    setTab("events");
  };

  const tabs = [
    { key: "events" as const, label: "Events", count: polls.length + set.length },
    { key: "form" as const, label: editing ? "Edit event" : "New event" },
    ...(can("viewAvailability") ? [{ key: "avail" as const, label: "Availability" }] : []),
  ];

  const card = (e: PortalEvent) => <StaffEventCard key={e.id} e={e} onEdit={() => startEdit(e)} />;

  return (
    <>
      <PageHead
        title="Schedule"
        access="Staff and admins"
      />
      {id && events.data && !target ? <p className="err">That event is not available. It may be older than 30 days.</p> : null}
      <Tabs
        idBase="ssched"
        label="Schedule"
        value={tab}
        onChange={(k) => {
          if (k !== "form") setEditing(undefined);
          setTab(k);
        }}
        tabs={tabs}
      />
      <div id="ssched-panel" role="tabpanel" aria-labelledby={`ssched-${tab}`} className="stack">
        {tab === "events" ? (
          <>
            {events.isPending ? <Loading /> : null}
            <ErrorNote error={events.error} onRetry={() => void events.refetch()} />
            <div className="bar">
              <h2>Time polls</h2>
              <button type="button" className="btn" onClick={() => setTab("form")}>
                New event
              </button>
            </div>
            {polls.length ? <div className="grid">{polls.map(card)}</div> : <Empty>No open polls.</Empty>}
            <div className="bar">
              <h2>Set</h2>
            </div>
            {set.length ? <div className="grid">{set.map(card)}</div> : <Empty>Nothing set yet.</Empty>}
            {cancelled.length ? (
              <details>
                <summary className="lbl">Cancelled ({cancelled.length})</summary>
                <div className="grid" style={{ marginTop: 12 }}>
                  {cancelled.map(card)}
                </div>
              </details>
            ) : null}
            {past.length ? (
              <details>
                <summary className="lbl">Past 30 days ({past.length})</summary>
                <div className="grid" style={{ marginTop: 12 }}>
                  {past.map(card)}
                </div>
              </details>
            ) : null}
          </>
        ) : null}
        {tab === "form" ? <EventForm key={editing?.id ?? "new"} event={editing} onDone={closeForm} /> : null}
        {tab === "avail" ? <Heatmap /> : null}
      </div>
    </>
  );
}

function StaffEventCard({ e, onEdit }: { e: PortalEvent; onEdit: () => void }) {
  const { zone } = useMe();
  const qc = useQueryClient();
  const toast = useToast();

  const act = useMutation({
    mutationFn: (input: { action: "lock"; optionId: string } | { action: "cancel" }) => api.eventAction(e.id, input),
    onSuccess: (ev, input) => {
      patchEvent(qc, ev);
      void qc.invalidateQueries({ queryKey: qk.events });
      toast(input.action === "lock" ? "Locked. Invitees are notified." : "Cancelled. Invitees are notified.");
    },
  });

  const votes = new Map((e.votes ?? []).map((v) => [v.optionId, v.people]));
  const max = Math.max(1, ...e.options.map((o) => votes.get(o.id)?.length ?? 0));
  const voters = new Set((e.votes ?? []).flatMap((v) => v.people.map((p) => p.sub)));

  const lock = (optionId: string, label: string) => {
    if (window.confirm(`Lock ${label}? Invitees are notified.`)) act.mutate({ action: "lock", optionId });
  };
  const cancel = () => {
    if (window.confirm(`Cancel "${e.title}"? Invitees are notified.`)) act.mutate({ action: "cancel" });
  };

  const byStatus = (s: RsvpStatus) => (e.rsvps ?? []).filter((r) => r.status === s).map((r) => r.person.name);
  const replies = e.rsvps?.length ?? 0;

  return (
    <article className="card" id={`event-${e.id}`} aria-labelledby={`sev-h-${e.id}`}>
      <EventTop e={e} />
      {e.status !== "poll" ? <SetTime e={e} zone={zone} /> : null}
      <h3 id={`sev-h-${e.id}`}>{e.title}</h3>
      <EventFacts e={e} />
      {e.status === "poll" ? (
        <div>
          <p className="meta">
            {voters.size} of {plural(e.invitedCount, "invitee")} answered.
          </p>
          {e.options.map((o) => {
            const people = votes.get(o.id) ?? [];
            const label = formatRange(o.startsAt, o.endsAt, zone);
            return (
              <div className="res" key={o.id}>
                <span>
                  <span className="t">{label}</span>
                  <span className="meta">{people.length ? people.map((p) => p.name).join(", ") : "Nobody yet"}</span>
                </span>
                <button
                  type="button"
                  className="btn ghost sm"
                  disabled={act.isPending}
                  onClick={() => lock(o.id, label)}
                >
                  Lock this time
                </button>
                <span className="meter" aria-hidden="true">
                  <i style={{ width: `${(people.length / max) * 100}%` }} />
                </span>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="stack" style={{ gap: 4 }}>
          <p className="meta">
            {replies} of {plural(e.invitedCount, "invitee")} replied.
          </p>
          {(["going", "maybe", "no"] as const).map((s) => {
            const names = byStatus(s);
            return names.length ? (
              <p className="note" key={s}>
                <span className="muted">{RSVP_LABELS[s]}: </span>
                {names.join(", ")}
              </p>
            ) : null;
          })}
        </div>
      )}
      {act.error ? (
        <p className="err" role="alert">
          {errorText(act.error)}
        </p>
      ) : null}
      <div className="foot row">
        <button type="button" className="btn ghost sm" onClick={onEdit}>
          Edit
        </button>
        {e.status !== "cancelled" ? (
          <button type="button" className="btn danger sm" disabled={act.isPending} onClick={cancel}>
            Cancel event
          </button>
        ) : null}
        <span className="meta">Created by {e.createdByName}</span>
      </div>
    </article>
  );
}
