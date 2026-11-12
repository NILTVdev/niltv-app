import { DisplayName, MemberAddRequest, MemberUpdateRequest, PortalMeUpdate, displayNameProblem, firstSafeName } from "@niltv/types";
import { describe, expect, it } from "vitest";

describe("display names", () => {
  it("accepts ordinary names, accents included", () => {
    for (const name of ["Jordan M.", "Zoë O’Neil", "José Álvarez-Núñez", "Team Captain", "Admina Lee"]) {
      expect(displayNameProblem(name)).toBeUndefined();
    }
  });

  it("refuses the names staff posts are signed with, however they are spelled", () => {
    for (const name of [
      "NIL TV",
      "NIL TV Team",
      "nil tv team",
      "NILTV  Team",
      "N.I.L. TV-Team",
      "ＮＩＬ ＴＶ Ｔｅａｍ",
      "Athlete support",
      "ATHLETE SUPPORT",
      "Content team",
      "Payments",
      "Staff",
      "admin",
    ]) {
      expect(displayNameProblem(name), name).toBeDefined();
    }
  });

  it("refuses look-alike letters from other scripts and digits", () => {
    for (const name of [
      "NІL TV Team", // Cyrillic I
      "NIL ТV", // Cyrillic T
      "ΝΙL TV", // Greek N and I
      "Stаff", // Cyrillic a
      "NlL TV",
      "N1L TV Team",
    ]) {
      expect(displayNameProblem(name), JSON.stringify(name)).toBeDefined();
    }
    for (const name of ["Анна", "Nils TV", "Neil"]) {
      expect(displayNameProblem(name), JSON.stringify(name)).toBeUndefined();
    }
  });

  it("picks the first safe name from names typed outside the portal", () => {
    expect(firstSafeName(["NIL TV Team", "  Jordan Miles  "])).toBe("Jordan Miles");
    expect(firstSafeName([undefined, null, "", "Jordan"])).toBe("Jordan");
    expect(firstSafeName(["Pay​ments", "Staff"])).toBe("Portal member");
    expect(firstSafeName(["x".repeat(90)])).toHaveLength(80);
  });

  it("refuses control and format characters", () => {
    for (const name of ["Jordan\nM.", "Jordan\r\nM.", "Jor\u0000dan", "‮maet VT LIN", "Jor​dan", "NIL­TV"]) {
      expect(displayNameProblem(name), JSON.stringify(name)).toBeDefined();
    }
  });

  it("trims and enforces length", () => {
    expect(DisplayName.parse("  Jordan  ")).toBe("Jordan");
    expect(DisplayName.safeParse("   ").success).toBe(false);
    expect(DisplayName.safeParse("x".repeat(81)).success).toBe(false);
  });

  it("applies to every request that sets a name", () => {
    expect(PortalMeUpdate.safeParse({ name: "NIL TV Team" }).success).toBe(false);
    expect(MemberAddRequest.safeParse({ email: "a@example.com", role: "guest", name: "Payments" }).success).toBe(false);
    expect(MemberUpdateRequest.safeParse({ name: "Line\nbreak" }).success).toBe(false);
    expect(PortalMeUpdate.safeParse({ name: "Jordan M." }).success).toBe(true);
  });

  it("carries the reason as the issue message", () => {
    const out = PortalMeUpdate.safeParse({ name: "Staff" });
    expect(out.success).toBe(false);
    if (!out.success) expect(out.error.issues[0]?.message).toMatch(/kept for NIL TV staff/);
  });
});
