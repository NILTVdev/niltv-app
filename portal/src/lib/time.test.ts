import { describe, expect, it } from "vitest";
import {
  dayDiff,
  formatDateTime,
  formatMessageTime,
  formatRange,
  formatSeen,
  tzOffsetMs,
  utcToWallTime,
  validZone,
  wallTimeToUtc,
  zoneAbbr,
} from "./time";

const NY = "America/New_York";

describe("zones", () => {
  it("reads the offset in and out of daylight time", () => {
    expect(tzOffsetMs(new Date("2026-07-01T12:00:00Z"), NY)).toBe(-4 * 3600_000);
    expect(tzOffsetMs(new Date("2026-12-01T12:00:00Z"), NY)).toBe(-5 * 3600_000);
    expect(tzOffsetMs(new Date("2026-12-01T12:00:00Z"), "UTC")).toBe(0);
  });

  it("turns a datetime-local value into the right UTC instant", () => {
    expect(wallTimeToUtc("2026-10-23T21:00", NY)?.toISOString()).toBe("2026-10-24T01:00:00.000Z");
    expect(wallTimeToUtc("2026-12-01T09:00", NY)?.toISOString()).toBe("2026-12-01T14:00:00.000Z");
    expect(wallTimeToUtc("2026-10-23T21:00", "Asia/Tokyo")?.toISOString()).toBe("2026-10-23T12:00:00.000Z");
    expect(wallTimeToUtc("not a time", NY)).toBeUndefined();
  });

  it("round-trips through the wall time on both sides of the DST change", () => {
    for (const local of ["2026-11-01T00:30", "2026-11-01T03:30", "2026-03-08T12:00", "2026-06-15T23:59"]) {
      const utc = wallTimeToUtc(local, NY)!;
      expect(utcToWallTime(utc, NY)).toBe(local);
    }
  });

  it("names the zone", () => {
    expect(zoneAbbr("2026-07-01T12:00:00Z", NY)).toBe("EDT");
    expect(zoneAbbr("2026-12-01T12:00:00Z", NY)).toBe("EST");
    expect(zoneAbbr("2026-12-01T12:00:00Z", "UTC")).toBe("UTC");
  });

  it("falls back for an unknown zone", () => {
    expect(validZone("Not/AZone", "UTC")).toBe("UTC");
    expect(validZone(NY)).toBe(NY);
    expect(validZone(undefined, NY)).toBe(NY);
  });
});

describe("formatting", () => {
  const now = new Date("2026-10-20T16:00:00Z"); // Tue Oct 20, noon in New York

  it("shows a full time with the zone", () => {
    expect(formatDateTime("2026-10-24T01:00:00Z", NY, now)).toBe("Fri, Oct 23, 9:00 PM EDT");
    expect(formatDateTime("2027-01-05T15:00:00Z", NY, now)).toBe("Tue, Jan 5, 2027, 10:00 AM EST");
  });

  it("shows ranges with 'to', never a dash", () => {
    expect(formatRange("2026-10-24T01:00:00Z", "2026-10-24T03:00:00Z", NY, now)).toBe(
      "Fri, Oct 23, 9:00 PM to 11:00 PM EDT",
    );
    expect(formatRange("2026-10-24T01:00:00Z", "2026-10-24T05:30:00Z", NY, now)).toBe(
      "Fri, Oct 23, 9:00 PM to Sat, Oct 24, 1:30 AM EDT",
    );
    expect(formatRange("2026-10-24T01:00:00Z", undefined, NY, now)).toBe("Fri, Oct 23, 9:00 PM EDT");
  });

  it("stamps messages by how long ago they were", () => {
    expect(formatMessageTime("2026-10-20T13:05:00Z", NY, now)).toBe("9:05 AM");
    expect(formatMessageTime("2026-10-19T13:05:00Z", NY, now)).toBe("Yesterday 9:05 AM");
    expect(formatMessageTime("2026-10-16T23:12:00Z", NY, now)).toBe("Fri 7:12 PM");
    expect(formatMessageTime("2026-10-01T13:00:00Z", NY, now)).toBe("Oct 1");
    expect(formatMessageTime("2025-10-01T13:00:00Z", NY, now)).toBe("Oct 1, 2025");
  });

  it("counts calendar days in the viewer's zone, not UTC", () => {
    // 11:30 PM Monday in New York is already Tuesday in UTC.
    expect(dayDiff(new Date("2026-10-20T03:30:00Z"), now, NY)).toBe(1);
    expect(dayDiff(new Date("2026-10-20T03:30:00Z"), now, "UTC")).toBe(0);
  });

  it("shows last seen", () => {
    expect(formatSeen(undefined, NY, now)).toBe("Never");
    expect(formatSeen("2026-10-20T14:00:00Z", NY, now)).toBe("Today");
    expect(formatSeen("2026-10-19T14:00:00Z", NY, now)).toBe("Yesterday");
    expect(formatSeen("2026-10-13T14:00:00Z", NY, now)).toBe("Oct 13");
  });
});
