import { describe, expect, it } from "vitest";
import { computeAge, is18Plus, parseBirthdate } from "./age";

const at = (iso: string): Date => new Date(iso);

describe("computeAge", () => {
  it("counts the 13th birthday on the day itself (U13 gate passes today)", () => {
    expect(computeAge("2013-07-17", at("2026-07-17T00:00:00Z"))).toBe(13);
    expect(computeAge("2013-07-17", at("2026-07-17T23:59:59Z"))).toBe(13);
  });

  it("is still 12 when the 13th birthday is tomorrow (U13 gate fails)", () => {
    expect(computeAge("2013-07-18", at("2026-07-17T23:59:59Z"))).toBe(12);
  });

  it("is month/day aware, not just a year delta", () => {
    // Born later in the year → birthday not reached yet.
    expect(computeAge("2013-08-01", at("2026-07-17T00:00:00Z"))).toBe(12);
    // Born earlier in the year → birthday already passed.
    expect(computeAge("2013-06-30", at("2026-07-17T00:00:00Z"))).toBe(13);
    // Same month, earlier day.
    expect(computeAge("2013-07-01", at("2026-07-17T00:00:00Z"))).toBe(13);
  });

  it("ticks Feb-29 birthdays over on Mar 1 in non-leap years", () => {
    expect(computeAge("2012-02-29", at("2025-02-28T12:00:00Z"))).toBe(12);
    expect(computeAge("2012-02-29", at("2025-03-01T00:00:00Z"))).toBe(13);
  });

  it("counts Feb-29 birthdays on the day itself in leap years", () => {
    expect(computeAge("2012-02-29", at("2028-02-28T00:00:00Z"))).toBe(15);
    expect(computeAge("2012-02-29", at("2028-02-29T00:00:00Z"))).toBe(16);
  });

  it("18 boundary: exactly 18 on the 18th birthday, 17 the day before", () => {
    expect(computeAge("2008-07-17", at("2026-07-17T00:00:00Z"))).toBe(18);
    expect(computeAge("2008-07-18", at("2026-07-17T00:00:00Z"))).toBe(17);
  });

  it("returns null for malformed or impossible birthdates", () => {
    const now = at("2026-07-17T00:00:00Z");
    expect(computeAge("", now)).toBeNull();
    expect(computeAge("2013/07/17", now)).toBeNull();
    expect(computeAge("17-07-2013", now)).toBeNull();
    expect(computeAge("2013-7-17", now)).toBeNull();
    expect(computeAge("2013-02-30", now)).toBeNull();
    expect(computeAge("2013-13-01", now)).toBeNull();
    expect(computeAge("not-a-date", now)).toBeNull();
  });
});

describe("is18Plus", () => {
  it("flips on the 18th birthday and is false for unknown birthdates", () => {
    const now = at("2026-07-17T00:00:00Z");
    expect(is18Plus("2008-07-17", now)).toBe(true);
    expect(is18Plus("2008-07-18", now)).toBe(false);
    expect(is18Plus("", now)).toBe(false);
    expect(is18Plus("garbage", now)).toBe(false);
  });
});

describe("parseBirthdate", () => {
  it("parses a valid date, including real leap days", () => {
    expect(parseBirthdate("2008-02-29")).toEqual({ year: 2008, month: 2, day: 29 });
  });

  it("rejects Feb 29 in a non-leap year", () => {
    expect(parseBirthdate("2009-02-29")).toBeNull();
  });
});
