/**
 * Promo copy for the competition surfaces — one source for the Home carousel
 * slides and the NIL STAR hub's promo sections, mirroring the site
 * (webapp /competitions/ + homepage hero slides). The Season 1 recap is
 * curated copy, as the site hardcodes it. The open and live branches are
 * event-generic: every date, prize and count comes off the EventCard, so
 * nothing here may name a season or a calendar date.
 */
import type { EventCard } from "@niltv/types";

import { inSubmissions } from "@/lib/events";

export interface PromoTlCard {
  kicker: string;
  main: string;
  sub?: string;
  gold?: boolean;
}

export interface PromoAction {
  /**
   * "submit" marks the entries-open CTA ("Enter Now"). The hero routes it to
   * the event page like an "event" action — only the event page itself opens
   * the external entry form.
   */
  type: "submit" | "event" | "notify";
  label: string;
}

export interface PromoCopy {
  pill: string;
  /** The site's green status text. */
  stat: string;
  /** Gold uppercase sub line under the headline. */
  sub?: string;
  /** Description paragraph (the site's hero-desc). */
  desc?: string;
  meta?: string;
  primary: PromoAction;
  ghost?: PromoAction;
  tl: PromoTlCard[];
}


/**
 * "Sep 23" style short date off an ISO timestamp, on the Eastern calendar.
 * Staff enter event bounds as midnight ET (startsAt T04:00Z, endsAt and
 * entriesCloseAt T03:59Z, see types/src/fixtures.ts), so rendering in the
 * device zone would print an open date a day early for every fan west of
 * Eastern and a close date a day late for anyone east of it. The site
 * publishes Eastern dates; the app prints the same day.
 */
export const PROMO_TIME_ZONE = "America/New_York";
export function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: PROMO_TIME_ZONE,
  });
}

/** Close date for the submissions window (no ticking counter). */
function closeDate(ev: Pick<EventCard, "entriesCloseAt" | "startsAt">): string {
  return shortDate(ev.entriesCloseAt ?? ev.startsAt);
}

/** Roadmap card for the prize. The award date is not on the card, so the prize itself leads. */
function prizeCard(ev: Pick<EventCard, "prize">): PromoTlCard {
  return ev.prize
    ? { kicker: "Grand Prize", main: ev.prize, sub: "Awarded to the winner" }
    : { kicker: "Grand Prize", main: "Winner Crowned", sub: "After the vote" };
}

export function promoForEvent(ev: EventCard, countdown: string | null): PromoCopy {
  const ticking = countdown && countdown !== "Ended" ? countdown : null;

  if (ev.status === "ended") {
    return {
      pill: "NIL Star Original Series",
      stat: "Season 1 Champion Crowned",
      sub: ev.winnerName
        ? `Season 1 Recap · ${ev.winnerName} Is Your First NIL Star`
        : "Season 1 Recap",
      desc:
        "Twenty finalists. A nationwide fan vote in three weeks. Bella Calvanese of " +
        "Sacred Heart University lacrosse was crowned the first ever NIL Star and took " +
        "home the $10,000 grand prize.",
      meta: ev.blurb,
      primary: { type: "event", label: "▶ Watch the Finale" },
      ghost: { type: "event", label: "ⓘ More Info" },
      tl: [
        { kicker: "Round One", main: "Nationwide Entries", sub: "July 7 · Entries gathered" },
        { kicker: "Round Two", main: "Top 20 Finalists", sub: "July 13–19 · Fan vote frenzy" },
        { kicker: "Grand Prize", main: "$10,000", sub: "Awarded to the champion" },
        { kicker: "Now Crowned", main: "Champion Crowned", sub: "July 22 · Bella Calvanese", gold: true },
      ],
    };
  }

  if (inSubmissions(ev)) {
    return {
      pill: "NIL TV Presents",
      stat: "Entries Open Now",
      sub: ev.prize ? `${ev.prize} Grand Prize` : undefined,
      desc:
        "Film your entry and post it as a collab with @NILTV and @NILSTAR. Fans pick the winner." +
        (ev.prize ? ` The winner takes home the ${ev.prize} grand prize.` : ""),
      meta: `Free to enter · Entries close ${closeDate(ev)}`,
      primary: { type: "submit", label: "＋ Enter Now" },
      ghost: { type: "event", label: "ⓘ How It Works" },
      tl: [
        { kicker: "Now Open", main: "Entries", sub: "Film your entry", gold: true },
        { kicker: "Entries Close", main: closeDate(ev), sub: "Last call" },
        { kicker: "Fan Vote", main: shortDate(ev.startsAt), sub: `Through ${shortDate(ev.endsAt)}` },
        prizeCard(ev),
      ],
    };
  }

  if (ev.status === "live") {
    return {
      pill: "NIL TV Presents",
      stat: "Voting Live",
      sub: ev.prize ? `${ev.prize} Grand Prize` : undefined,
      desc: "The finalists are in and the fan vote is on. Watch every entry and back your pick before the window closes.",
      meta: ticking ? `Voting closes in ${ticking}` : ev.blurb,
      primary: { type: "event", label: "▶ Vote Now" },
      ghost: { type: "event", label: "ⓘ How It Works" },
      tl: [
        { kicker: "Live Now", main: "Public Voting", sub: "Pick your finalist", gold: true },
        { kicker: "Voting Closes", main: shortDate(ev.endsAt), sub: "Last call" },
        prizeCard(ev),
      ],
    };
  }

  return {
    pill: "NIL TV Presents",
    stat: "Coming Soon",
    sub: ev.prize ? `${ev.prize} Grand Prize` : undefined,
    meta: ev.blurb,
    primary: { type: "notify", label: "Notify Me" },
    ghost: { type: "event", label: "ⓘ Details" },
    tl: [{ kicker: "Up Next", main: ev.title, sub: ev.blurb ?? "", gold: true }],
  };
}
