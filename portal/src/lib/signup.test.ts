import { describe, expect, it } from "vitest";
import { inviteFromUrl, siteSignupUrl } from "./signup";

describe("inviteFromUrl", () => {
  it("reads the address from an old invite link", () => {
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

describe("siteSignupUrl", () => {
  it("points at the niltv.com sign-up box", () => {
    expect(siteSignupUrl()).toBe("https://niltv.com/?account=create");
  });

  it("carries the address, encoded", () => {
    expect(siteSignupUrl("jordan+nil@example.edu")).toBe("https://niltv.com/?account=create&email=jordan%2Bnil%40example.edu");
  });
});
