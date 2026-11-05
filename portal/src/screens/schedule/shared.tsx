/** Pieces both schedule views use: event facts, cache patching. */
import { EVENT_KIND_LABELS, type EventsResponse, type PortalEvent } from "@niltv/types";
import type { QueryClient } from "@tanstack/react-query";
import { lockedOption } from "../../lib/events";
import { formatRange } from "../../lib/time";
import { qk } from "../../queries";
import { Pill } from "../../ui/bits";

/** Put an action's response into the cached list, keeping staff-only fields it does not carry. */
export function patchEvent(qc: QueryClient, ev: PortalEvent): void {
  qc.setQueryData<EventsResponse>(qk.events, (old) =>
    old
      ? {
          events: old.events.map((x) =>
            x.id === ev.id ? { ...x, ...ev, votes: ev.votes ?? x.votes, rsvps: ev.rsvps ?? x.rsvps } : x,
          ),
        }
      : old,
  );
}

export function EventTop({ e }: { e: PortalEvent }) {
  return (
    <div className="card-top">
      <span className="row tight">
        <span className="fmt">{EVENT_KIND_LABELS[e.kind]}</span>
        <span className="tgt">{e.audienceLabel}</span>
      </span>
      {e.status === "cancelled" ? <Pill tone="bad">Cancelled</Pill> : e.status === "poll" ? <Pill tone="info">Pick a time</Pill> : null}
    </div>
  );
}

/** Description, location and stream link. */
export function EventFacts({ e }: { e: PortalEvent }) {
  return (
    <>
      {e.description ? <p className="desc">{e.description}</p> : null}
      {e.location || e.streamUrl ? (
        <div className="stack" style={{ gap: 4 }}>
          {e.location ? (
            <span className="note">
              <span className="muted">Where: </span>
              {e.location}
            </span>
          ) : null}
          {e.streamUrl ? (
            <span className="note">
              <span className="muted">Stream: </span>
              <a href={e.streamUrl} target="_blank" rel="noopener noreferrer">
                {e.streamUrl.replace(/^https?:\/\//, "")}
              </a>
            </span>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

/** The set time, big. */
export function SetTime({ e, zone }: { e: PortalEvent; zone: string }) {
  const t = lockedOption(e);
  return t ? <span className="when-big">{formatRange(t.startsAt, t.endsAt, zone)}</span> : null;
}
