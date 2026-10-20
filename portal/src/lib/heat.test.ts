import { describe, expect, it } from "vitest";
import { bestSlots, heatRatio, heatShade, slotKey } from "./heat";

describe("heatmap shading", () => {
  it("ramps opacity with the share of responders", () => {
    expect(heatShade(0, 24).background).toBe("rgba(217,178,91,0.08)");
    expect(heatShade(12, 24).background).toBe("rgba(217,178,91,0.51)");
    expect(heatShade(24, 24).background).toBe("rgba(217,178,91,0.93)");
  });

  it("switches to dark text once the cell is dark", () => {
    expect(heatShade(10, 24).color).toBe("var(--text)");
    expect(heatShade(12, 24).color).toBe("var(--on-gold)");
  });

  it("is safe with nobody responded and clamps over-counts", () => {
    expect(heatRatio(3, 0)).toBe(0);
    expect(heatShade(3, 0).background).toBe("rgba(217,178,91,0.08)");
    expect(heatRatio(30, 24)).toBe(1);
  });

  it("picks the best times, busiest first, ties in week order", () => {
    const cells = [
      { slot: slotKey("thu", "evening"), count: 5 },
      { slot: slotKey("mon", "evening"), count: 5 },
      { slot: slotKey("sat", "morning"), count: 9 },
      { slot: slotKey("sun", "late"), count: 0 },
    ];
    expect(bestSlots(cells).map((c) => c.slot)).toEqual(["sat-morning", "mon-evening", "thu-evening"]);
    expect(bestSlots([{ slot: "mon-late", count: 0 }])).toEqual([]);
  });
});
