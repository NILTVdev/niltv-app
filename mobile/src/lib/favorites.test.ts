import { describe, expect, it } from "vitest";
import type { MeFavorites } from "@niltv/types";

import {
  createFavoritesDraft,
  favoriteSportLabel,
  favoriteSports,
  favoritesEqual,
  favoritesErrorMessage,
  normalizeFavorites,
  schoolOptions,
  toggleFavorite,
} from "./favorites";

const saved: MeFavorites = {
  schools: ["Example State"],
  sports: ["soccer", "basketball"],
  channels: ["ch-active"],
};

describe("favorite settings helpers", () => {
  it("loads saved selections into a separate draft and drops inactive channels", () => {
    const stored = { ...saved, channels: ["ch-active", "ch-retired"] };
    const draft = createFavoritesDraft(stored, ["ch-active"]);

    expect(draft).toEqual(saved);
    expect(draft.schools).not.toBe(stored.schools);
    expect(stored.channels).toEqual(["ch-active", "ch-retired"]);
  });

  it("toggles values without adding duplicate selections", () => {
    expect(toggleFavorite(["soccer"], "basketball")).toEqual(["soccer", "basketball"]);
    expect(toggleFavorite(["soccer", "soccer"], "soccer")).toEqual([]);
  });

  it("normalizes submitted values and compares selections without order dependence", () => {
    const normalized = normalizeFavorites({
      schools: [" Example State ", "example state"],
      sports: ["soccer", "soccer"],
      channels: ["ch-active", "ch-active"],
    });
    expect(normalized).toEqual({
      schools: ["Example State"],
      sports: ["soccer"],
      channels: ["ch-active"],
    });
    expect(favoritesEqual(saved, { ...saved, sports: [...saved.sports].reverse() })).toBe(true);
  });

  it("derives school options from directory data and preserves saved choices", () => {
    expect(
      schoolOptions(
        [{ school: "Example State" }, { school: "Example Tech" }, { school: "example state" }, { school: " " }],
        ["Legacy College"],
      ),
    ).toEqual(["Example State", "Example Tech", "Legacy College"]);
  });

  it("uses shared favorite sports without internal classifications", () => {
    expect(favoriteSports).not.toContain("none-visible");
    expect(favoriteSports).not.toContain("multi-sport");
    expect(favoriteSportLabel("track-field")).toBe("Track & Field");
  });

  it("returns useful messages for authorization, validation, and network failures", () => {
    expect(favoritesErrorMessage({ status: 401 }, "save")).toMatch(/session has expired/i);
    expect(favoritesErrorMessage({ code: "INVALID_REQUEST" }, "save")).toMatch(/no longer available/i);
    expect(favoritesErrorMessage(new Error("offline"), "save")).toMatch(/check your connection/i);
  });
});