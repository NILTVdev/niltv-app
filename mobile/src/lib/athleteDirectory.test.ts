import { describe, expect, it } from "vitest";
import { athleteFilterOptions, filterAthletes } from "./athleteDirectory";
import { athleteParams } from "./athleteRoute";

const athletes = [
  { id: "a-1", name: "Zoe Martin", school: "Duke", sport: "Soccer", isAmbassador: false },
  { id: "a-2", name: "José Lee", school: "UNC", sport: "Soccer", isAmbassador: false, profilePublished: true },
  { id: "a-3", name: "Jose Lee", school: " Duke ", sport: "Lacrosse", isAmbassador: false },
  { id: "a-4", name: "Alex Smith", school: "", sport: "", isAmbassador: false },
];

describe("athlete directory", () => {
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
