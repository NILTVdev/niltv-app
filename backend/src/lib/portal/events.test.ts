import { describe, expect, it } from "vitest";
import { hasAnswered } from "./events";

const event = { options: [{ id: "a" }, { id: "b" }] };

describe("hasAnswered", () => {
  it("is false with no vote row", () => {
    expect(hasAnswered(event, undefined)).toBe(false);
  });

  it("counts a pick", () => {
    expect(hasAnswered(event, { optionIds: ["a"] })).toBe(true);
  });

  it("counts a saved answer with nothing ticked: none of these work", () => {
    expect(hasAnswered(event, { optionIds: [] })).toBe(true);
  });

  it("no longer counts when every pick was removed", () => {
    expect(hasAnswered(event, { optionIds: ["gone"] })).toBe(false);
  });

  it("still counts when one of the picks remains", () => {
    expect(hasAnswered(event, { optionIds: ["gone", "b"] })).toBe(true);
  });

  it("asks again after a time was added", () => {
    const changed = { ...event, timesChangedAt: "2026-11-05T12:00:00.000Z" };
    expect(hasAnswered(changed, { optionIds: ["a"], at: "2026-11-05T11:00:00.000Z" })).toBe(false);
    expect(hasAnswered(changed, { optionIds: [], at: "2026-11-05T11:00:00.000Z" })).toBe(false);
    expect(hasAnswered(changed, { optionIds: ["a"], at: "2026-11-05T13:00:00.000Z" })).toBe(true);
  });
});
