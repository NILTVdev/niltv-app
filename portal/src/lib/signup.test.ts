import { describe, expect, it } from "vitest";
import { ageOn, inviteFromUrl } from "./signup";

describe("inviteFromUrl", () => {
  it("opens the step with the address from the invite link", () => {
    expect(inviteFromUrl("/create-account", "?email=jordan%2Bnil%40example.edu")).toEqual({
      create: true,
      email: "jordan+nil@example.edu",
    });
  });

  it("works with no address and a trailing slash", () => {
    expect(inviteFromUrl("/create-account/", "")).toEqual({ create: true, email: "" });
  });

  it("ignores every other path", () => {
    expect(inviteFromUrl("/", "?email=a@example.com")).toEqual({ create: false, email: "" });
    expect(inviteFromUrl("/messages", "")).toEqual({ create: false, email: "" });
  });
});

describe("ageOn", () => {
  const today = new Date(2026, 10, 4);

  it("counts whole years", () => {
    expect(ageOn("2000-01-15", today)).toBe(26);
  });

  it("turns over on the birthday, not before", () => {
    expect(ageOn("2008-11-04", today)).toBe(18);
    expect(ageOn("2008-11-05", today)).toBe(17);
  });

  it("refuses dates that cannot be used", () => {
    expect(ageOn("", today)).toBeNull();
    expect(ageOn("2000-02-31", today)).toBeNull();
    expect(ageOn("2030-01-01", today)).toBeNull();
    expect(ageOn("01/02/2000", today)).toBeNull();
  });
});
