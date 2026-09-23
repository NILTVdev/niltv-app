import { describe, expect, it } from "vitest";
import { displayNameOf, previousHandlesOf, profileFromAmbassador } from "./roster";

const amb = {
  id: 9001,
  ig_username: "7sample",
  display_name: "Sam | Growing Through Discipline",
  previous_usernames: "sample.athlete, None",
  campus: "unc",
  school: null,
  sport: null,
  year: null,
  cohort: "F26",
  status: "confirmed",
  active: true,
};

describe("roster sync", () => {
  it("keeps the name and drops the Instagram tagline", () => {
    expect(displayNameOf(amb)).toBe("Sam");
    expect(displayNameOf({ display_name: null, ig_username: "abc" })).toBe("abc");
  });

  it("parses previous handles, dropping the dashboard's None", () => {
    expect(previousHandlesOf(amb)).toEqual(["sample.athlete"]);
  });

  it("creates an athlete-only profile keyed by handle, with roster identity", () => {
    const row = profileFromAmbassador(amb, undefined, "2026-09-10T00:00:00Z");
    expect(row).toMatchObject({
      PK: "ATHLETE#ath-7sample",
      id: "ath-7sample",
      name: "Sam",
      handle: "7sample",
      statuses: ["athlete"],
      campus: "unc",
      rosterId: "9001",
      rosterStatus: "confirmed",
      previousHandles: ["sample.athlete"],
      GSI1PK: "PROFILES#ALL",
      GSI1SK: "Sam",
    });
    expect(row?.["school"]).toBe("");
  });

  it("never overwrites staff-owned fields on an existing profile", () => {
    const existing = { id: "ath-sam", name: "Sam Sample", nameOverride: true, handle: "sample.athlete", school: "UNC", sport: "Track & Field", statuses: ["athlete", "ambassador"], ambassadorRank: 2, bio: "written by staff", GSI1SK: "02" };
    const row = profileFromAmbassador(amb, existing, "2026-09-10T00:00:00Z");
    expect(row).toMatchObject({ id: "ath-sam", name: "Sam Sample", handle: "7sample", school: "UNC", sport: "Track & Field", statuses: ["athlete", "ambassador"], ambassadorRank: 2, bio: "written by staff", GSI1SK: "02" });
  });

  it("skips rows without a handle", () => {
    expect(profileFromAmbassador({ ...amb, ig_username: null }, undefined, "2026-09-10T00:00:00Z")).toBeUndefined();
  });
});
