import { describe, expect, it } from "vitest";
import { CAMPUS_COMBO, SPORT_COMBO, matchOptions } from "./combo";

const options = [
  { value: "a", label: "Gold Salem TV" },
  { value: "b", label: "Golden Dome TV" },
  { value: "c", label: "Salt City TV" },
];

describe("matchOptions", () => {
  it("shows everything before anything is typed", () => {
    expect(matchOptions(options, "  ")).toHaveLength(3);
  });

  it("ignores case", () => {
    expect(matchOptions(options, "GOLDEN").map((o) => o.value)).toEqual(["b"]);
  });

  it("puts names that start with the text first", () => {
    expect(matchOptions(options, "sal").map((o) => o.value)).toEqual(["c", "a"]);
  });

  it("finds nothing for text in no name", () => {
    expect(matchOptions(options, "zzz")).toEqual([]);
  });
});

describe("shared lists", () => {
  it("has every campus and sport", () => {
    expect(CAMPUS_COMBO.length).toBeGreaterThan(0);
    expect(SPORT_COMBO.length).toBeGreaterThan(0);
  });
});
