import { describe, expect, it } from "vitest";
import { requireStaff } from "./authz";

/** Minimal JWT-authorized event carrying the given cognito:groups claim (or none). */
function eventWithGroups(groups?: unknown) {
  return {
    requestContext: {
      authorizer: {
        jwt: {
          claims: groups === undefined ? {} : { "cognito:groups": groups },
        },
      },
    },
  } as never;
}

describe("requireStaff — the three claim shapes, fail closed", () => {
  it("accepts a real array containing staff", () => {
    expect(requireStaff(eventWithGroups(["staff"]))).toBe(true);
    expect(requireStaff(eventWithGroups(["admins", "staff"]))).toBe(true);
  });

  it("accepts a plain string claim", () => {
    expect(requireStaff(eventWithGroups("staff"))).toBe(true);
  });

  it("accepts the API Gateway stringified-array form", () => {
    expect(requireStaff(eventWithGroups("[staff]"))).toBe(true);
    expect(requireStaff(eventWithGroups("[admins staff]"))).toBe(true);
    expect(requireStaff(eventWithGroups("[admins, staff]"))).toBe(true);
  });

  it("denies when the claim is missing (fail closed)", () => {
    expect(requireStaff(eventWithGroups())).toBe(false);
    expect(requireStaff({ requestContext: {} } as never)).toBe(false);
    expect(requireStaff({} as never)).toBe(false);
  });

  it("denies non-staff groups in every shape", () => {
    expect(requireStaff(eventWithGroups(["admins"]))).toBe(false);
    expect(requireStaff(eventWithGroups("admins"))).toBe(false);
    expect(requireStaff(eventWithGroups("[admins]"))).toBe(false);
    expect(requireStaff(eventWithGroups(""))).toBe(false);
  });

  it("never matches staff as a substring of another group", () => {
    expect(requireStaff(eventWithGroups("staffing"))).toBe(false);
    expect(requireStaff(eventWithGroups("[staffing old-staff]"))).toBe(false);
    expect(requireStaff(eventWithGroups(["staffing"]))).toBe(false);
  });

  it("denies non-string surprises (numbers, objects)", () => {
    expect(requireStaff(eventWithGroups(42))).toBe(false);
    expect(requireStaff(eventWithGroups({ group: "staff" }))).toBe(false);
  });
});
