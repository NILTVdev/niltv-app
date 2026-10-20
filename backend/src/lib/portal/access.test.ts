import { PORTAL_PERMISSIONS, desksFor, portalCan } from "@niltv/types";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sendMock = vi.hoisted(() => vi.fn());

vi.mock("../db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../db")>();
  return { ...actual, getDocClient: () => ({ send: sendMock }) };
});

import { authorize } from "./access";

const event = (sub?: string) =>
  ({ requestContext: { authorizer: { jwt: { claims: sub ? { sub } : {} } } } }) as never;

const row = (over: Record<string, unknown>) => ({
  Item: {
    PK: "USER#u-1",
    SK: "PORTAL",
    sub: "u-1",
    email: "a@example.com",
    name: "Jordan M.",
    role: "athlete",
    status: "active",
    createdAt: "2026-10-01T00:00:00.000Z",
    ...over,
  },
});

describe("authorize", () => {
  beforeEach(() => {
    sendMock.mockReset();
    process.env.TABLE_NAME = "niltv-test";
  });

  it("401s without a sub claim and never reads the table", async () => {
    const out = await authorize(event());
    expect("response" in out && out.response.statusCode).toBe(401);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("403s a signed-in account with no portal row", async () => {
    sendMock.mockResolvedValueOnce({});
    const out = await authorize(event("u-1"));
    expect("response" in out && out.response.statusCode).toBe(403);
    expect("response" in out && JSON.parse(out.response.body as string).error).toBe("NOT_MEMBER");
  });

  it("403s ready and disabled members", async () => {
    for (const status of ["ready", "disabled"]) {
      sendMock.mockResolvedValueOnce(row({ status }));
      const out = await authorize(event("u-1"));
      expect("response" in out && out.response.statusCode).toBe(403);
    }
  });

  it("returns the member for an active row", async () => {
    sendMock.mockResolvedValueOnce(row({}));
    const out = await authorize(event("u-1"));
    expect("caller" in out && out.caller.member.role).toBe("athlete");
  });
});

describe("permission table", () => {
  it("matches the agreed access matrix", () => {
    expect(portalCan("athlete", "requestPageChange")).toBe(true);
    expect(portalCan("guest", "viewPostings")).toBe(false);
    expect(portalCan("guest", "manageEvents")).toBe(false);
    expect(portalCan("staff", "manageGuests")).toBe(true);
    expect(portalCan("staff", "manageGroups")).toBe(false);
    expect(portalCan("staff", "manageAccess")).toBe(false);
    expect(portalCan("staff", "viewPayouts")).toBe(false);
    expect(portalCan("admin", "manageAccess")).toBe(true);
    expect(portalCan(undefined, "viewPostings")).toBe(false);
  });

  it("gives every permission to at least one role and nothing staff-only to athletes", () => {
    for (const roles of Object.values(PORTAL_PERMISSIONS)) expect(roles.length).toBeGreaterThan(0);
    for (const p of ["moderate", "manageEvents", "viewRoster", "manageAccess"] as const) {
      expect(portalCan("athlete", p)).toBe(false);
      expect(portalCan("guest", p)).toBe(false);
    }
  });

  it("keeps guests off the payments desk and staff off it too", () => {
    expect(desksFor("guest")).toEqual(["content", "support"]);
    expect(desksFor("staff")).not.toContain("payments");
    expect(desksFor("admin")).toContain("payments");
    expect(desksFor("athlete")).toContain("payments");
  });
});
