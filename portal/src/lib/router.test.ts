import { describe, expect, it } from "vitest";
import { PATHS, parsePath, pathFor } from "./router";

describe("router paths", () => {
  it("maps every screen path back to its screen", () => {
    for (const [screen, path] of Object.entries(PATHS)) expect(parsePath(path).screen).toBe(screen);
  });

  it("reads deep links with an id", () => {
    expect(parsePath("/messages/desk-content-abc")).toEqual({ screen: "messages", id: "desk-content-abc" });
    expect(parsePath("/schedule/ev-01H")).toEqual({ screen: "schedule", id: "ev-01H" });
    expect(parsePath("/postings/post-9/")).toEqual({ screen: "postings", id: "post-9" });
    expect(parsePath("/messages/ch-sport-women%27s-soccer")).toEqual({ screen: "messages", id: "ch-sport-women's-soccer" });
  });

  it("ignores trailing slashes, queries and hashes", () => {
    expect(parsePath("/account/")).toEqual({ screen: "account" });
    expect(parsePath("/help?x=1#top")).toEqual({ screen: "help" });
  });

  it("returns null for unknown paths and ids on screens without them", () => {
    expect(parsePath("/nope")).toEqual({ screen: null });
    expect(parsePath("/account/123")).toEqual({ screen: null });
    expect(parsePath("/messages/a/b")).toEqual({ screen: null });
  });

  it("builds paths, encoding ids", () => {
    expect(pathFor("home")).toBe("/");
    expect(pathFor("messages", "ch-sport-women's soccer")).toBe("/messages/ch-sport-women's%20soccer");
    expect(pathFor("account", "ignored")).toBe("/account");
  });
});
