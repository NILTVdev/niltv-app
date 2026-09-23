import { describe, expect, it } from "vitest";
import { createMilestoneGate } from "./milestones";

describe("createMilestoneGate", () => {
  it("emits a milestone once for the active page", () => {
    const gate = createMilestoneGate();
    expect(gate.allow(true, "video_start")).toBe(true);
    expect(gate.allow(true, "video_start")).toBe(false);
  });

  it("never emits from a preloaded neighbour", () => {
    // The regression: a paused-but-preloaded page briefly reported isPlaying
    // and its start was attributed to the clip the viewer was actually on.
    const gate = createMilestoneGate();
    expect(gate.allow(false, "video_start")).toBe(false);
    expect(gate.allow(false, "video_progress_25")).toBe(false);
  });

  it("does not let a suppressed neighbour event consume the real view", () => {
    const gate = createMilestoneGate();
    gate.allow(false, "video_start"); // fires while preloading, must not count
    // …viewer swipes here and the page becomes active for real.
    expect(gate.allow(true, "video_start")).toBe(true);
  });

  it("counts each milestone type independently", () => {
    const gate = createMilestoneGate();
    expect(gate.allow(true, "video_start")).toBe(true);
    expect(gate.allow(true, "video_progress_25")).toBe(true);
    expect(gate.allow(true, "video_complete")).toBe(true);
    expect(gate.allow(true, "video_progress_25")).toBe(false);
  });

  it("re-arms only after the page goes inactive", () => {
    const gate = createMilestoneGate();
    expect(gate.allow(true, "video_start")).toBe(true);
    expect(gate.allow(true, "video_start")).toBe(false);
    gate.reset(); // page scrolled away
    expect(gate.allow(true, "video_start")).toBe(true); // viewer came back
  });
});
