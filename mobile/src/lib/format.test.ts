import { describe, expect, it } from "vitest";

import { attribution, formatCount, formatDuration, nilSchool, schoolMeta } from "./format";

describe("attribution", () => {
  it("collapses an identical channel and creator to one name", () => {
    // Channel clips credit the channel's own pseudo-profile — this used to
    // render "NIL TV · NIL TV" on every card.
    expect(attribution("NIL TV", "NIL TV")).toBe("NIL TV");
  });

  it("keeps both when a real creator is credited", () => {
    expect(attribution("TrueBlue TV", "Camila Garza")).toBe("TrueBlue TV · Camila Garza");
  });
});

describe("formatCount", () => {
  it("abbreviates thousands", () => {
    expect(formatCount(999)).toBe("999");
    expect(formatCount(24_811)).toMatch(/24/);
  });
});

describe("formatDuration", () => {
  it("renders m:ss", () => {
    expect(formatDuration(36)).toBe("0:36");
    expect(formatDuration(134)).toBe("2:14");
  });
});

describe("nilSchool", () => {
  it("appends the required phrase to a bare school name", () => {
    expect(nilSchool("Duke")).toBe("Duke NIL Student Athletes");
    expect(nilSchool("Vanderbilt & Wyoming")).toBe("Vanderbilt & Wyoming NIL Student Athletes");
  });

  it("never doubles the phrase and never renders a bare name from padded input", () => {
    expect(nilSchool("Duke NIL Student Athletes")).toBe("Duke NIL Student Athletes");
    expect(nilSchool("  Duke ")).toBe("Duke NIL Student Athletes");
  });

  it("stays empty for empty input", () => {
    expect(nilSchool("")).toBe("");
    expect(nilSchool("   ")).toBe("");
  });
});

describe("schoolMeta", () => {
  it("joins the phrase with the sport", () => {
    expect(schoolMeta("Duke", "Lacrosse")).toBe("Duke NIL Student Athletes · Lacrosse");
  });

  it("drops missing parts instead of stray separators", () => {
    expect(schoolMeta("Duke")).toBe("Duke NIL Student Athletes");
    expect(schoolMeta("", "Lacrosse")).toBe("Lacrosse");
  });
});
