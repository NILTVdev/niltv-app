/** Athletes and guests: pick times on polls, RSVP to set events, set your usual week. */
import type { PortalEvent, RsvpStatus } from "@niltv/types";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { api, errorText } from "../../api";
import { byStart, isPast, lockedOption } from "../../lib/events";
import { RSVP_LABELS } from "../../lib/format";
import { downloadIcs } from "../../lib/ics";
import { formatRange } from "../../lib/time";
import { useEvents } from "../../queries";
import { Empty, ErrorNote, Loading, PageHead, Tabs } from "../../ui/bits";
import { useMe } from "../../ui/me";
import { useToast } from "../../ui/Toast";
import { useFlash } from "../../ui/useFlash";
import { AvailabilityGrid } from "./AvailabilityGrid";
import { EventFacts, EventTop, patchEvent, SetTime } from "./shared";

type Tab = "pick" | "upcoming" | "avail";

export function MemberSchedule({ id }: { id?: string }) {
  const events = useEvents();
  const all = events.data ?? [];
  const polls = all.filter((e) => e.status === "poll").sort(byStart);
  const upcoming = all.filter((e) => e.status !== "poll" && !isPast(e)).sort(byStart);
  const unanswered = polls.filter((e) => e.myVotes.length === 0).length;
  const target = id ? all.find((e) => e.id === id) : undefined;

  const [tab, setTab] = useState<Tab>("pick");
  // A deep link opens the tab its event is on, once.
  const routed = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (target && routed.current !== target.id) {
      routed.current = target.id;
      setTab(target.status === "poll" ? "pick" : "upcoming");
    }
  }, [target]);
  useFlash(target ? `event-${target.id}` : undefined, Boolean(target));

  return (
    <>
      <PageHead
        title="Schedule"
        sub="Find times that work for gaming, streams and shoots, then see what is coming up."
        access="Events you are invited to"
      />
      {id && events.data && !target ? <p className="err">That event is not available. It may have ended or been removed.</p> : null}
      <Tabs
        idBase="sched"
        label="Schedule"
        value={tab}
        onChange={setTab}
        tabs={[
          { key: "pick", label: "Pick times", count: unanswered },
          { key: "upcoming", label: "Upcoming", count: upcoming.filter((e) => e.status === "set").length },
          { key: "avail", label: "My availability" },
        ]}
      />
      <div id="sched-panel" role="tabpanel" aria-labelledby={`sched-${tab}`} className="stack">
        {tab !== "avail" && events.isPending ? <Loading /> : null}
        {tab !== "avail" ? <ErrorNote error={events.error} onRetry={() => void events.refetch()} /> : null}
        {tab === "pick" && events.data ? (
          polls.length ? (
            <div className="grid">
              {polls.map((e) => (
                <PollCard key={e.id} e={e} />
              ))}
            </div>
          ) : (
            <Empty>No time polls right now.</Empty>
          )
        ) : null}
        {tab === "upcoming" && events.data ? (
          upcoming.length ? (
            <div className="grid">
              {upcoming.map((e) => (
                <UpcomingCard key={e.id} e={e} />
              ))}
            </div>
          ) : (
            <Empty>Nothing scheduled yet.</Empty>
          )
        ) : null}
        {tab === "avail" ? <AvailabilityGrid /> : null}
      </div>
    </>
  );
}

const sameSet = (a: ReadonlySet<string>, b: readonly string[]): boolean => a.size === b.length && b.every((x) => a.has(x));

function PollCard({ e }: { e: PortalEvent }) {
  const { zone } = useMe();
  const qc = useQueryClient();
  const toast = useToast();
  const [picked, setPicked] = useState<Set<string>>(() => new Set(e.myVotes));
  const dirty = !sameSet(picked, e.myVotes);

  const vote = useMutation({
    mutationFn: () => api.eventAction(e.id, { action: "vote", optionIds: [...picked] }),
    onSuccess: (ev) => {
      patchEvent(qc, ev);
      toast("Saved. Staff lock the best time.");
    },
  });

  const toggle = (optionId: string) =>
    setPicked((cur) => {
      const next = new Set(cur);
      if (next.has(optionId)) next.delete(optionId);
      else next.add(optionId);
      return next;
    });

  return (
    <article className="card" id={`event-${e.id}`} aria-labelledby={`ev-h-${e.id}`}>
      <EventTop e={e} />
      <h3 id={`ev-h-${e.id}`}>{e.title}</h3>
      <EventFacts e={e} />
      <div className="opts" role="group" aria-label="Times that work for you">
        {e.options.map((o) => {
          const on = picked.has(o.id);
          return (
            <button key={o.id} type="button" className="opt" aria-pressed={on} onClick={() => toggle(o.id)}>
              <span className="row tight">
                <span className="tick" aria-hidden="true">
                  {on ? "✓" : ""}
                </span>
                <span className="l">{formatRange(o.startsAt, o.endsAt, zone)}</span>
              </span>
            </button>
          );
        })}
      </div>
      {vote.error ? (
        <p className="err" role="alert">
          {errorText(vote.error)}
        </p>
      ) : null}
      <div className="foot row">
        <button type="button" className="btn" disabled={!dirty || vote.isPending} onClick={() => vote.mutate()}>
          {vote.isPending ? "Saving…" : "Save my times"}
        </button>
        <span className="note">
          {dirty
            ? picked.size === 0
              ? "Saving with nothing ticked tells staff none of these work."
              : "Not saved yet."
            : e.myVotes.length
              ? "Saved. Staff pick the best time."
              : "Tick every time that works."}
        </span>
      </div>
    </article>
  );
}

function UpcomingCard({ e }: { e: PortalEvent }) {
  const { zone } = useMe();
  const qc = useQueryClient();
  const toast = useToast();
  const cancelled = e.status === "cancelled";

  const rsvp = useMutation({
    mutationFn: (status: RsvpStatus) => api.eventAction(e.id, { action: "rsvp", status }),
    onSuccess: (ev) => {
      patchEvent(qc, ev);
      toast("Reply saved.");
    },
  });

  const addToCalendar = () => {
    const t = lockedOption(e);
    if (!t) return;
    downloadIcs({
      uid: `${e.id}@portal.niltv.com`,
      title: e.title,
      startsAt: t.startsAt,
      endsAt: t.endsAt,
      description: e.description,
      location: e.location,
      url: e.streamUrl,
    });
  };

  return (
    <article className="card" id={`event-${e.id}`} aria-labelledby={`ev-h-${e.id}`}>
      <EventTop e={e} />
      <SetTime e={e} zone={zone} />
      <h3 id={`ev-h-${e.id}`}>{e.title}</h3>
      <EventFacts e={e} />
      {rsvp.error ? (
        <p className="err" role="alert">
          {errorText(rsvp.error)}
        </p>
      ) : null}
      {cancelled ? (
        <p className="note">This event is cancelled.</p>
      ) : (
        <div className="foot row">
          <div className="seg" role="group" aria-label="Your reply">
            {(["going", "maybe", "no"] as const).map((s) => (
              <button
                key={s}
                type="button"
                aria-pressed={e.myRsvp === s}
                disabled={rsvp.isPending}
                onClick={() => rsvp.mutate(s)}
              >
                {RSVP_LABELS[s]}
              </button>
            ))}
          </div>
          <button type="button" className="btn ghost sm" onClick={addToCalendar}>
            Add to calendar
          </button>
        </div>
      )}
    </article>
  );
}
