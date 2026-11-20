import { describe, expect, it } from "vitest";
import { canOpen, moreItems, navFor, screensFor, startScreen } from "./nav";

const keys = (role: Parameters<typeof navFor>[0]) =>
  navFor(role).groups.map((g) => [g.title, g.items.map((i) => i.key)]);

describe("navigation by role", () => {
  it("gives athletes the mockup menu", () => {
    expect(keys("athlete")).toEqual([
      [null, ["home", "hub", "messages", "schedule", "postings"]],
      ["You", ["posts", "page", "payments", "account"]],
    ]);
    expect(navFor("athlete").footer.map((i) => i.key)).toEqual(["refer", "help"]);
    expect(navFor("athlete").bottom).toEqual(["home", "hub", "messages", "schedule"]);
  });

  it("gives guests messages, schedule, profile and help", () => {
    expect(keys("guest")).toEqual([[null, ["messages", "schedule", "account"]]]);
    expect(navFor("guest").groups[0]!.items.find((i) => i.key === "account")!.label).toBe("Profile");
    expect(navFor("guest").footer.map((i) => i.key)).toEqual(["help"]);
    expect(navFor("guest").bottom).toEqual(["messages", "schedule", "account", "help"]);
    expect(moreItems("guest")).toEqual([]);
  });

  it("gives staff the people screens and no admin group", () => {
    expect(keys("staff")).toEqual([
      [null, ["home", "hub", "messages", "schedule", "postings", "athletes", "guests", "requests"]],
      ["You", ["account"]],
    ]);
    expect(navFor("staff").footer).toEqual([]);
  });

  it("adds Payouts and Team & access for admins", () => {
    expect(keys("admin")).toEqual([
      [null, ["home", "hub", "messages", "schedule", "postings", "athletes", "guests", "requests"]],
      ["Admin", ["payouts", "access"]],
      ["You", ["account"]],
    ]);
  });

  it("refuses screens a role does not have", () => {
    expect(canOpen("athlete", "athletes")).toBe(false);
    expect(canOpen("athlete", "payments")).toBe(true);
    expect(canOpen("guest", "home")).toBe(false);
    expect(canOpen("guest", "postings")).toBe(false);
    expect(canOpen("guest", "help")).toBe(true);
    expect(canOpen("staff", "payouts")).toBe(false);
    expect(canOpen("staff", "page")).toBe(false);
    expect(canOpen("admin", "access")).toBe(true);
    expect(canOpen("admin", "payments")).toBe(false);
  });

  it("puts the rest of the menu under More on phones", () => {
    expect(moreItems("athlete").map((i) => i.key)).toEqual(["postings", "posts", "page", "payments", "account", "refer", "help"]);
    expect(moreItems("admin").map((i) => i.key)).toContain("access");
  });

  it("lands guests on Messages and everyone else on Home", () => {
    expect(startScreen("guest")).toBe("messages");
    expect(startScreen("athlete")).toBe("home");
    expect(screensFor("guest").has(startScreen("guest"))).toBe(true);
    for (const role of ["athlete", "staff", "admin"] as const) expect(screensFor(role).has(startScreen(role))).toBe(true);
  });
});
