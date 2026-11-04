import { describe, expect, it } from "vitest";
import { pickLook } from "./look";

describe("pickLook", () => {
  it("defaults to the white main area", () => {
    expect(pickLook(null, null)).toBe("light");
  });

  it("uses what this browser remembered", () => {
    expect(pickLook(null, "dark")).toBe("dark");
  });

  it("lets the URL win over what was remembered", () => {
    expect(pickLook("light", "dark")).toBe("light");
  });

  it("ignores values it does not know", () => {
    expect(pickLook("blue", "green")).toBe("light");
    expect(pickLook("blue", "dark")).toBe("dark");
  });
});
