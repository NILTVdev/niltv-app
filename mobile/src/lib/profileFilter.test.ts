import { describe, expect, it } from "vitest";

import { NO_FILTERS, filterOptions, filterProfiles } from "./profileFilter";

const roster = [
  { name: "José Alvarez", school: "Duke", sport: "Soccer" },
  { name: "Camila Reyes", school: "Duke", sport: "Gymnastics" },
  { name: "Mia Chen", school: "UCLA", sport: "Soccer" },
  { name: "Sam Lee", school: "", sport: "" },
];

describe("filterProfiles", () => {
  it("returns everyone with no filters", () => {
    expect(filterProfiles(roster, NO_FILTERS)).toEqual(roster);
  });
  it("searches names case-insensitively and ignoring accents", () => {
    expect(filterProfiles(roster, { ...NO_FILTERS, query: "jose" }).map((p) => p.name)).toEqual(["José Alvarez"]);
    expect(filterProfiles(roster, { ...NO_FILTERS, query: "  REY " }).map((p) => p.name)).toEqual(["Camila Reyes"]);
  });
  it("combines school and sport with the name search", () => {
    expect(filterProfiles(roster, { query: "", school: "Duke", sport: "Soccer" }).map((p) => p.name)).toEqual([
      "José Alvarez",
    ]);
    expect(filterProfiles(roster, { query: "mia", school: "Duke", sport: null })).toEqual([]);
  });
});

describe("filterOptions", () => {
  it("lists distinct, sorted, non-empty values", () => {
    expect(filterOptions(roster, "school")).toEqual(["Duke", "UCLA"]);
    expect(filterOptions(roster, "sport")).toEqual(["Gymnastics", "Soccer"]);
  });
});
