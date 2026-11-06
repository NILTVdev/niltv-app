import { describe, expect, it } from "vitest";
import { athleteFilterOptions, discoverAthletes, filterAthletes, spotlightAthlete } from "./athleteDirectory";
import { athleteParams } from "./athleteRoute";

const athletes = [
  { id: "a-1", name: "Zoe Martin", school: "Duke", sport: "Soccer", isAmbassador: false },
  { id: "a-2", name: "José Lee", school: "UNC", sport: "Soccer", isAmbassador: false, profilePublished: true },
  { id: "a-3", name: "Jose Lee", school: " Duke ", sport: "Lacrosse", isAmbassador: false },
  { id: "a-4", name: "Alex Smith", school: "", sport: "", isAmbassador: false },
];

describe("athlete directory", () => {
  const preview = (id: string, publishedAt: string) => ({ id, title: "Latest clip", publishedAt });

  it("discovers only athletes with videos, newest first, without changing the roster", () => {
    const roster = [
      { ...athletes[0]!, latestVideo: preview("old", "2026-09-01T00:00:00Z") },
      athletes[1]!,
      { ...athletes[2]!, latestVideo: preview("new", "2026-10-01T00:00:00Z") },
    ];
    expect(discoverAthletes(roster).map((athlete) => athlete.id)).toEqual(["a-3", "a-1"]);
    expect(roster[0]?.id).toBe("a-1");
    expect(filterAthletes(roster, "", "", "")).toHaveLength(3);
    expect(discoverAthletes(filterAthletes(roster, "", "UNC", ""))).toEqual([]);
  });

  it("spotlights only a ranked ambassador with a playable preview", () => {
    const roster = [
      { ...athletes[0]!, isAmbassador: true, ambassadorRank: 1 },
      { ...athletes[1]!, isAmbassador: true, ambassadorRank: 3, latestVideo: preview("v2", "2026-10-01T00:00:00Z") },
      { ...athletes[2]!, isAmbassador: true, ambassadorRank: 2, latestVideo: preview("v3", "2026-09-01T00:00:00Z") },
    ];
    expect(spotlightAthlete(roster)?.id).toBe("a-3");
    expect(spotlightAthlete(athletes)).toBeUndefined();
  });

  it("combines name, school and sport without confusing duplicate names", () => {
    expect(filterAthletes(athletes, " JOSE ", "unc", "soccer").map((a) => a.id)).toEqual(["a-2"]);
    expect(filterAthletes(athletes, "lee", "duke", "lacrosse").map((a) => a.id)).toEqual(["a-3"]);
    expect(filterAthletes(athletes, "lee", "Duke", "Soccer")).toEqual([]);
  });

  it("clears to an alphabetical roster and leaves the source order intact", () => {
    expect(filterAthletes(athletes, "", "", "")[0]?.name).toBe("Alex Smith");
    expect(athletes[0]?.name).toBe("Zoe Martin");
  });

  it("deduplicates filter options and omits missing values", () => {
    expect(athleteFilterOptions(athletes, "school")).toEqual(["Duke", "UNC"]);
    expect(athleteFilterOptions(athletes, "sport")).toEqual(["Lacrosse", "Soccer"]);
  });

  it("uses stable IDs and sends unpublished profiles to their video listing", () => {
    expect(athleteParams(athletes[0]!)).toMatchObject({ id: "a-1", videos: "1" });
    expect(athleteParams(athletes[1]!)).toMatchObject({ id: "a-2", videos: "0" });
  });
});
