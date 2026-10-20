/** Schedule event helpers: which time is set, when it starts and ends. Pure. */
import type { PortalEvent, TimeOption } from "@niltv/types";

const HOUR_MS = 60 * 60 * 1000;

/** The locked time of a set event. */
export const lockedOption = (e: PortalEvent): TimeOption | undefined =>
  e.options.find((o) => o.id === e.lockedOptionId) ?? (e.status === "set" ? e.options[0] : undefined);

/** Start of the set time, or the first option of a poll. */
export function eventStartMs(e: PortalEvent): number {
  const locked = lockedOption(e);
  if (locked) return Date.parse(locked.startsAt);
  return Math.min(...e.options.map((o) => Date.parse(o.startsAt)));
}

/** End of the set time (start + 1 hour when open-ended), or the last option of a poll. */
export function eventEndMs(e: PortalEvent): number {
  const locked = lockedOption(e);
  const opts = locked ? [locked] : e.options;
  return Math.max(...opts.map((o) => (o.endsAt ? Date.parse(o.endsAt) : Date.parse(o.startsAt) + HOUR_MS)));
}

export const isPast = (e: PortalEvent, now: number = Date.now()): boolean => eventEndMs(e) < now;

export const byStart = (a: PortalEvent, b: PortalEvent): number => eventStartMs(a) - eventStartMs(b);

/** Set events still ahead (or running), soonest first. */
export const upcomingSet = (events: readonly PortalEvent[], now: number = Date.now()): PortalEvent[] =>
  events.filter((e) => e.status === "set" && !isPast(e, now)).sort(byStart);

/** Open polls the member has not answered. */
export const unansweredPolls = (events: readonly PortalEvent[]): PortalEvent[] =>
  events.filter((e) => e.status === "poll" && e.myVotes.length === 0);
