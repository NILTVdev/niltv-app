import { describe, expect, it } from "vitest";

import { fitDisplaySize } from "./fitTitle";

describe("fitDisplaySize", () => {
  it("keeps the max size when the longest line fits", () => {
    expect(fitDisplaySize("Sweat It Out", 343, 34)).toBe(34);
  });
  it("shrinks so the longest line of a two-line title fits a 375pt phone", () => {
    // 31 glyphs at 0.55em: 343 / 17.05 = 20
    expect(fitDisplaySize("Student Athlete Run Channels\nLocal Content Created Their Way", 343, 34)).toBe(20);
    expect(fitDisplaySize("NIL TV Athletes\nCreating Content Their Way", 343, 34)).toBe(23);
  });
  it("never goes under the floor and tolerates empty input", () => {
    expect(fitDisplaySize("A".repeat(80), 200, 34)).toBe(16);
    expect(fitDisplaySize("", 343, 34)).toBe(34);
  });
});
