import { describe, expect, it } from "vitest";
import { DAY_TIMES, dayTimeLabel, upgradeSlots } from "@niltv/types";
import { bestSlots, copyDay, heatRatio, heatShade, hourLabel, slotKey } from "./heat";

describe("heatmap shading", () => {
  it("ramps opacity with the share of responders", () => {
    expect(heatShade(0, 24).background).toBe("rgba(211,179,104,0.08)");
    expect(heatShade(12, 24).background).toBe("rgba(211,179,104,0.51)");
    expect(heatShade(24, 24).background).toBe("rgba(211,179,104,0.93)");
  });

  it("switches to dark text once the cell is dark", () => {
    expect(heatShade(14, 24).color).toBe("var(--text)");
    expect(heatShade(15, 24).color).toBe("var(--on-gold)");
  });

  it("is safe with nobody responded and clamps over-counts", () => {
    expect(heatRatio(3, 0)).toBe(0);
    expect(heatShade(3, 0).background).toBe("rgba(211,179,104,0.08)");
    expect(heatRatio(30, 24)).toBe(1);
  });

  it("picks the best times, busiest first, ties in week order", () => {
    const cells = [
      { slot: slotKey("thu", "1730"), count: 5 },
      { slot: slotKey("mon", "1730"), count: 5 },
      { slot: slotKey("sat", "0900"), count: 9 },
      { slot: slotKey("sun", "2200"), count: 0 },
    ];
    expect(bestSlots(cells).map((c) => c.slot)).toEqual(["sat-0900", "mon-1730", "thu-1730"]);
    expect(bestSlots([{ slot: "mon-2200", count: 0 }])).toEqual([]);
  });
});

describe("half-hour rows", () => {
  it("runs from 6 AM to the last half hour before midnight", () => {
    expect(DAY_TIMES).toHaveLength(36);
    expect(DAY_TIMES[0]).toBe("0600");
    expect(DAY_TIMES.at(-1)).toBe("2330");
  });

  it("reads like a clock", () => {
    expect(dayTimeLabel("0630")).toBe("6:30 AM");
    expect(dayTimeLabel("1200")).toBe("12:00 PM");
    expect(dayTimeLabel("1730")).toBe("5:30 PM");
    expect(hourLabel("1200")).toBe("12 PM");
    expect(hourLabel("1230")).toBe("");
  });

  it("turns saved blocks into half hours", () => {
    expect(upgradeSlots(["thu-evening"])).toEqual(["thu-1700", "thu-1730", "thu-1800", "thu-1830", "thu-1900", "thu-1930", "thu-2000", "thu-2030"]);
    expect(upgradeSlots(["sat-late"]).at(-1)).toBe("sat-2330");
  });

  it("keeps new slots, drops junk and survives a missing list", () => {
    expect(upgradeSlots(["mon-0900", "mon-0900", "nope", 3])).toEqual(["mon-0900"]);
    expect(upgradeSlots(undefined)).toEqual([]);
  });

  it("copies one day over others and replaces what they had", () => {
    const out = copyDay(new Set(["mon-0900", "tue-1700", "sat-1000"]), "mon", ["tue", "wed"]);
    expect([...out].sort()).toEqual(["mon-0900", "sat-1000", "tue-0900", "wed-0900"]);
  });
});
