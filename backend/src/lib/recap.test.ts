import { describe, expect, it } from "vitest";
import { computeRecap } from "./recap";

const eventRow = {
  id: "ev-x",
  startsAt: "2026-09-07T00:00:00.000Z",
  endsAt: "2026-09-25T00:00:00.000Z",
};

const entry = (id: string, votes: number) => ({ id, votes });

describe("computeRecap (design §6.5 frozen leaderboard)", () => {
  it("returns undefined for an entry-less event", () => {
    expect(computeRecap(eventRow, [])).toBeUndefined();
  });

  it("ranks by votes descending with sequential ranks", () => {
    const recap = computeRecap(eventRow, [entry("en-a", 5), entry("en-b", 12), entry("en-c", 7)]);
    expect(recap?.championEntryId).toBe("en-b");
    expect(recap?.leaderboard).toEqual([
      { entryId: "en-b", rank: 1, votes: 12 },
      { entryId: "en-c", rank: 2, votes: 7 },
      { entryId: "en-a", rank: 3, votes: 5 },
    ]);
  });

  it("breaks vote ties by entry id ascending — deterministic under any input order", () => {
    const a = computeRecap(eventRow, [entry("en-b", 5), entry("en-a", 5)]);
    const b = computeRecap(eventRow, [entry("en-a", 5), entry("en-b", 5)]);
    expect(a?.leaderboard).toEqual(b?.leaderboard);
    expect(a?.championEntryId).toBe("en-a");
  });

  it("totals votes/entries and computes daysLive from the window", () => {
    const recap = computeRecap(eventRow, [entry("en-a", 3), entry("en-b", 4)]);
    expect(recap?.totals).toEqual({ votes: 7, entries: 2, daysLive: 18 });
  });

  it("treats a missing votes attribute as zero", () => {
    const recap = computeRecap(eventRow, [{ id: "en-a" }, entry("en-b", 1)]);
    expect(recap?.championEntryId).toBe("en-b");
    expect(recap?.totals.votes).toBe(1);
  });

  it("clamps a sub-day window to daysLive of 1 and bad dates to 0", () => {
    const short = computeRecap(
      { ...eventRow, endsAt: "2026-09-07T06:00:00.000Z" },
      [entry("en-a", 1)],
    );
    expect(short?.totals.daysLive).toBe(1);
    const bad = computeRecap({ ...eventRow, endsAt: "nope" }, [entry("en-a", 1)]);
    expect(bad?.totals.daysLive).toBe(0);
  });
});
