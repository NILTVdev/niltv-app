import type { PortalEvent } from "@niltv/types";
import { describe, expect, it } from "vitest";
import { openPolls, scheduleCount, topOptions, unansweredPolls } from "./events";

const NOW = Date.parse("2026-11-05T12:00:00.000Z");
const FUTURE = "2026-11-08T12:00:00.000Z";
const PAST = "2026-11-01T12:00:00.000Z";

const event = (over: Partial<PortalEvent>): PortalEvent => ({
  id: "e",
  title: "Test",
  kind: "stream",
  description: "",
  status: "poll",
  options: [{ id: "a", startsAt: FUTURE }],
  audience: { type: "everyone" },
  audienceLabel: "Every athlete",
  createdByName: "Staff",
  createdAt: PAST,
  myVotes: [],
  myAnswered: false,
  invitedCount: 2,
  ...over,
});

const person = (sub: string) => ({ sub, name: sub, role: "athlete" as const });

describe("open events", () => {
  it("drops an event once every time has passed", () => {
    const gone = event({ options: [{ id: "a", startsAt: PAST }] });
    expect(openPolls([gone, event({ id: "live" })], NOW).map((e) => e.id)).toEqual(["live"]);
  });

  it("keeps one that still has a time ahead", () => {
    const mixed = event({ options: [{ id: "a", startsAt: PAST }, { id: "b", startsAt: FUTURE }] });
    expect(openPolls([mixed], NOW)).toHaveLength(1);
  });

  it("treats none of these work as answered", () => {
    expect(unansweredPolls([event({ myAnswered: true, myVotes: [] })], NOW)).toHaveLength(0);
  });
});

describe("scheduleCount", () => {
  const set = event({ id: "set", status: "set", lockedOptionId: "a" });

  it("counts unanswered picks and set events with no reply for members", () => {
    expect(scheduleCount([event({}), set], false, NOW)).toBe(2);
    expect(scheduleCount([event({ myAnswered: true }), { ...set, myRsvp: "going" }], false, NOW)).toBe(0);
  });

  it("counts events waiting on a final time for staff", () => {
    expect(scheduleCount([event({}), set], true, NOW)).toBe(1);
  });
});

describe("topOptions", () => {
  it("is empty until somebody picks", () => {
    expect(topOptions(event({ votes: [{ optionId: "a", people: [] }] })).size).toBe(0);
  });

  it("marks every option tied for the most", () => {
    const e = event({
      votes: [
        { optionId: "a", people: [person("x"), person("y")] },
        { optionId: "b", people: [person("x"), person("z")] },
        { optionId: "c", people: [person("x")] },
      ],
    });
    expect([...topOptions(e)].sort()).toEqual(["a", "b"]);
  });
});
