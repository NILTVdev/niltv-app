import { NotifyPrefs, type PortalMember, isPushServiceUrl, upgradeNotifyPrefs } from "@niltv/types";
import { describe, expect, it } from "vitest";
import {
  DAY_MS,
  type SummaryState,
  addActivity,
  cadenceFor,
  isQuietHour,
  localDay,
  messageTopic,
  nextLocalHour,
  outOfQuietHours,
  planSummary,
  shouldPush,
  summaryDueFor,
  validZone,
} from "./prefs";

const NY = "America/New_York";
const HOUR = 60 * 60 * 1000;

const member = (over: Partial<PortalMember> = {}): PortalMember => ({
  sub: "u-1",
  email: "a@example.com",
  name: "Jordan M.",
  role: "athlete",
  status: "active",
  desks: [],
  edited: [],
  notify: NotifyPrefs.parse({}),
  createdAt: "2026-10-01T00:00:00.000Z",
  ...over,
});

const state = (over: Partial<SummaryState> = {}): SummaryState => ({ notes: [], ignored: 0, rev: 0, ...over });

/** 2026-10-21 at {hour}:00 New York time (EDT, UTC-4). */
const ny = (hour: number, day = 21): Date => new Date(Date.UTC(2026, 9, day, hour + 4));

describe("notification preferences", () => {
  it("default to: messages to you, groups, announcements and schedule right away; postings daily; channels off", () => {
    expect(NotifyPrefs.parse({})).toEqual({
      direct: "now",
      groups: "now",
      announcements: "now",
      channels: "off",
      schedule: "now",
      postings: "daily",
      previews: true,
    });
  });

  it("read rows saved with the old on/off email flags", () => {
    expect(
      NotifyPrefs.parse({ directMessages: true, groupMessages: false, channelMessages: true, announcements: false, schedule: true, postings: true }),
    ).toMatchObject({ direct: "now", groups: "off", channels: "daily", announcements: "off", schedule: "now", postings: "daily" });
  });

  it("let a value in the new shape win over a leftover flag", () => {
    expect(upgradeNotifyPrefs({ directMessages: true, direct: "daily", announcements: "off" })).toEqual({ direct: "daily", announcements: "off" });
  });

  it("never push channels, and nothing for a member who is not active", () => {
    expect(cadenceFor(member({ notify: { ...NotifyPrefs.parse({}), channels: "now" } }), "channels")).toBe("daily");
    expect(cadenceFor(member({ status: "disabled" }), "direct")).toBe("off");
  });

  it("file a message under the right topic", () => {
    expect(messageTopic({ kind: "desk" }, false)).toBe("direct");
    expect(messageTopic({ kind: "channel", scope: { type: "sport" } }, true)).toBe("direct");
    expect(messageTopic({ kind: "group" }, false)).toBe("groups");
    expect(messageTopic({ kind: "channel", scope: { type: "announcements" } }, false)).toBe("announcements");
    expect(messageTopic({ kind: "channel", scope: { type: "campus" } }, false)).toBe("channels");
  });
});

describe("time zones and quiet hours", () => {
  it("knows 10 PM to 8 AM is quiet in the member's zone", () => {
    expect(isQuietHour(ny(21), NY)).toBe(false);
    expect(isQuietHour(ny(22), NY)).toBe(true);
    expect(isQuietHour(ny(7), NY)).toBe(true);
    expect(isQuietHour(ny(8), NY)).toBe(false);
    // 9 PM in New York is 6 PM in Los Angeles.
    expect(isQuietHour(ny(23), "America/Los_Angeles")).toBe(false);
  });

  it("finds the next 8 AM, across midnight and across a clock change", () => {
    expect(nextLocalHour(ny(23), NY, 8).toISOString()).toBe(ny(8, 22).toISOString());
    expect(nextLocalHour(ny(3), NY, 8).toISOString()).toBe(ny(8).toISOString());
    // US clocks fall back on Nov 1, 2026: 8 AM EST is 13:00 UTC.
    expect(nextLocalHour(new Date("2026-10-31T23:00:00.000Z"), NY, 8).toISOString()).toBe("2026-11-01T13:00:00.000Z");
    // Half-hour zones land on the half hour.
    expect(nextLocalHour(new Date("2026-10-21T00:00:00.000Z"), "Asia/Kolkata", 8).toISOString()).toBe("2026-10-21T02:30:00.000Z");
  });

  it("moves a send out of quiet hours, and leaves daytime alone", () => {
    expect(outOfQuietHours(ny(2), NY).toISOString()).toBe(ny(8).toISOString());
    expect(outOfQuietHours(ny(15), NY).toISOString()).toBe(ny(15).toISOString());
  });

  it("falls back to the team zone for a missing or broken zone", () => {
    expect(validZone(undefined)).toBe(NY);
    expect(validZone("Mars/Base")).toBe(NY);
    expect(validZone("Europe/London")).toBe("Europe/London");
    expect(localDay(ny(23), NY)).toBe("2026-10-21");
  });
});

describe("queueing a summary", () => {
  it("is due an hour later for right-away topics, and at 8 AM for daily ones", () => {
    expect(summaryDueFor("now", ny(14), NY).toISOString()).toBe(ny(15).toISOString());
    expect(summaryDueFor("now", ny(21, 21), NY).toISOString()).toBe(ny(8, 22).toISOString());
    expect(summaryDueFor("daily", ny(14), NY).toISOString()).toBe(ny(8, 22).toISOString());
  });

  it("keeps the earliest due time and adds notes", () => {
    const first = addActivity(state(), { at: ny(9), cadence: "daily", zone: NY });
    const second = addActivity(state(first), {
      at: ny(10),
      cadence: "now",
      zone: NY,
      note: { topic: "direct", text: "You're approved for X", path: "/postings/p", at: ny(10).toISOString() },
    });
    expect(second.pendingSince).toBe(ny(9).toISOString());
    expect(second.dueAt).toBe(ny(11).toISOString());
    expect(second.notes).toHaveLength(1);
    const third = addActivity(state(second), { at: ny(10, 21), cadence: "daily", zone: NY });
    expect(third.dueAt).toBe(ny(11).toISOString());
  });

  it("starts over when the member has opened the portal since the summary began", () => {
    const pending = state({ pendingSince: ny(9).toISOString(), dueAt: ny(10).toISOString(), notes: [{ topic: "direct", text: "old", path: "/", at: ny(9).toISOString() }] });
    const next = addActivity(pending, { at: ny(13), cadence: "now", zone: NY, lastSeenAt: ny(12).toISOString() });
    expect(next).toEqual({ pendingSince: ny(13).toISOString(), dueAt: ny(14).toISOString(), notes: [] });
  });
});

describe("planning a due summary", () => {
  const pending = (over: Partial<SummaryState> = {}): SummaryState =>
    state({ pendingSince: ny(9).toISOString(), dueAt: ny(10).toISOString(), ...over });

  it("sends the first one", () => {
    expect(planSummary({ now: ny(10), zone: NY, state: pending() })).toEqual({ action: "send", ignored: 0, weekly: false, last: false });
  });

  it("drops it when the member came back after it started, or nothing is pending", () => {
    expect(planSummary({ now: ny(10), zone: NY, lastSeenAt: ny(9).toISOString(), state: pending() })).toEqual({ action: "drop", reason: "seen" });
    expect(planSummary({ now: ny(10), zone: NY, state: state() })).toMatchObject({ action: "drop" });
  });

  it("waits a day after a summary the member ignored", () => {
    const plan = planSummary({ now: ny(10), zone: NY, lastSeenAt: ny(6, 20).toISOString(), state: pending({ lastSummaryAt: ny(8).toISOString() }) });
    expect(plan).toEqual({ action: "wait", until: new Date(ny(8).getTime() + DAY_MS) });
  });

  it("waits only three hours when the member came back after the last one", () => {
    // Summary at 8:00, visit at 8:30, new activity at 9:00.
    const back = planSummary({
      now: ny(12),
      zone: NY,
      lastSeenAt: new Date(ny(8).getTime() + 30 * 60 * 1000).toISOString(),
      state: pending({ lastSummaryAt: ny(8).toISOString() }),
    });
    expect(back).toEqual({ action: "send", ignored: 0, weekly: false, last: false });
    const tooSoon = planSummary({
      now: ny(10),
      zone: NY,
      lastSeenAt: new Date(ny(8).getTime() + 30 * 60 * 1000).toISOString(),
      state: pending({ lastSummaryAt: ny(8).toISOString() }),
    });
    expect(tooSoon).toEqual({ action: "wait", until: ny(11) });
  });

  it("slows to weekly after three ignored summaries, then stops", () => {
    const lastSummaryAt = new Date(ny(10).getTime() - 8 * DAY_MS).toISOString();
    expect(planSummary({ now: ny(10), zone: NY, state: pending({ lastSummaryAt, ignored: 2 }) })).toEqual({
      action: "send",
      ignored: 3,
      weekly: true,
      last: false,
    });
    expect(planSummary({ now: ny(10), zone: NY, state: pending({ lastSummaryAt, ignored: 5 }) })).toMatchObject({ action: "send", last: true });
    expect(planSummary({ now: ny(10), zone: NY, state: pending({ lastSummaryAt, ignored: 6 }) })).toEqual({ action: "drop", reason: "stopped" });
    const recent = new Date(ny(10).getTime() - 2 * DAY_MS).toISOString();
    expect(planSummary({ now: ny(10), zone: NY, state: pending({ lastSummaryAt: recent, ignored: 3 }) })).toMatchObject({ action: "wait" });
  });

  it("never sends in quiet hours", () => {
    expect(planSummary({ now: ny(23), zone: NY, state: pending() })).toEqual({ action: "wait", until: ny(8, 22) });
  });
});

describe("push", () => {
  const base = { cadence: "now" as const, topic: "groups" as const, now: ny(15), zone: NY };

  it("buzzes for right-away topics only", () => {
    expect(shouldPush(base)).toBe(true);
    expect(shouldPush({ ...base, cadence: "daily" })).toBe(false);
  });

  it("stays quiet when the member is in the portal now", () => {
    expect(shouldPush({ ...base, lastSeenAt: new Date(ny(15).getTime() - 60 * 1000).toISOString() })).toBe(false);
    expect(shouldPush({ ...base, lastSeenAt: new Date(ny(15).getTime() - HOUR).toISOString() })).toBe(true);
  });

  it("holds everything but direct messages at night", () => {
    expect(shouldPush({ ...base, now: ny(23) })).toBe(false);
    expect(shouldPush({ ...base, topic: "direct", now: ny(23) })).toBe(true);
  });

  it("accepts only browser push services as endpoints", () => {
    expect(isPushServiceUrl("https://fcm.googleapis.com/fcm/send/abc")).toBe(true);
    expect(isPushServiceUrl("https://web.push.apple.com/QGx")).toBe(true);
    expect(isPushServiceUrl("https://updates.push.services.mozilla.com/wpush/v2/x")).toBe(true);
    expect(isPushServiceUrl("https://db5p.notify.windows.com/w/?token=x")).toBe(true);
    expect(isPushServiceUrl("http://fcm.googleapis.com/fcm/send/abc")).toBe(false);
    expect(isPushServiceUrl("https://fcm.googleapis.com:8443/x")).toBe(false);
    expect(isPushServiceUrl("https://fcm.googleapis.com.evil.example/x")).toBe(false);
    expect(isPushServiceUrl("https://169.254.169.254/latest")).toBe(false);
    expect(isPushServiceUrl("not a url")).toBe(false);
  });
});
