import type { EventCard } from "@niltv/types";
import { describe, expect, it } from "vitest";

import { promoForEvent, shortDate } from "./promoCopy";

/**
 * Promo dates render on the Eastern calendar, whatever zone the device is in.
 * The file pins the process zone to Pacific before any Date is formatted
 * (nothing formats at import time): the bug this guards (a midnight-ET start
 * printing the previous day) only shows on a device west of Eastern, and the
 * machine running the suite is not guaranteed to be one.
 */
process.env["TZ"] = "America/Los_Angeles";

/** Staff convention for event bounds: midnight ET open, 23:59 ET close. */
const openEvent: EventCard = {
  id: "evt-next",
  title: "Next Event",
  status: "upcoming",
  startsAt: "2099-10-05T04:00:00Z",
  endsAt: "2099-10-15T03:59:00Z",
  entriesCloseAt: "2099-09-24T03:59:00Z",
  submitUrl: "https://example.com/enter",
  prize: "$10,000",
};

describe("shortDate", () => {
  it("prints the Eastern calendar day, not the device's", () => {
    // Sanity: the zone pin took effect, so the device zone really would say Oct 4.
    expect(
      new Date(openEvent.startsAt).toLocaleDateString("en-US", { month: "short", day: "numeric" }),
    ).toBe("Oct 4");
    expect(shortDate(openEvent.startsAt)).toBe("Oct 5");
  });

  it("keeps a 23:59 ET close on its own day", () => {
    expect(shortDate(openEvent.endsAt)).toBe("Oct 14");
    expect(shortDate(openEvent.entriesCloseAt as string)).toBe("Sep 23");
  });
});

describe("promoForEvent dates", () => {
  it("entries-open roadmap carries the published dates", () => {
    const promo = promoForEvent(openEvent, null);
    expect(promo.meta).toBe("Free to enter · Entries close Sep 23");
    expect(promo.tl.map((c) => c.main)).toEqual(["Entries", "Sep 23", "Oct 5", "$10,000"]);
    expect(promo.tl[2]).toEqual({ kicker: "Fan Vote", main: "Oct 5", sub: "Through Oct 14" });
  });

  it("live roadmap closes on the published day", () => {
    const promo = promoForEvent({ ...openEvent, status: "live" }, "3d 4h");
    expect(promo.tl[1]).toEqual({ kicker: "Voting Closes", main: "Oct 14", sub: "Last call" });
  });
});
