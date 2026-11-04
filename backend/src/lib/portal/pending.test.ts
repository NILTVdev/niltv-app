import { beforeEach, describe, expect, it, vi } from "vitest";

const send = vi.hoisted(() => vi.fn());

vi.mock("../db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../db")>()),
  getDocClient: () => ({ send }),
}));

import { claimInvite, listPending, savePending } from "./pending";

const ccf = Object.assign(new Error("conditional"), { name: "ConditionalCheckFailedException" });
const row = {
  applicationId: 7,
  email: "a@example.com",
  name: "Jordan Miles",
  firstSeenAt: "2026-11-01T00:00:00.000Z",
};

beforeEach(() => {
  send.mockReset();
  process.env.TABLE_NAME = "niltv-test";
});

describe("savePending", () => {
  it("never touches invitedAt and keeps the first firstSeenAt", async () => {
    send.mockResolvedValue({});
    await savePending({ ...row, sport: "Rowing" });
    const input = send.mock.calls[0]![0].input;
    expect(input.Key).toEqual({ PK: "PORTAL#PENDING", SK: "APP#7" });
    expect(input.UpdateExpression).toContain("#firstSeenAt = if_not_exists(#firstSeenAt, :firstSeenAt)");
    expect(input.UpdateExpression).not.toContain("invitedAt");
  });

  it("clears a field the application no longer has", async () => {
    send.mockResolvedValue({});
    await savePending(row);
    expect(send.mock.calls[0]![0].input.UpdateExpression).toContain("REMOVE #campus, #school, #sport");
  });

  it("aliases every name, because name is a reserved word", async () => {
    send.mockResolvedValue({});
    await savePending(row);
    const input = send.mock.calls[0]![0].input;
    expect(input.UpdateExpression).toContain("#name = :name");
    expect(input.ExpressionAttributeNames["#name"]).toBe("name");
  });
});

describe("claimInvite", () => {
  const at = new Date("2026-11-04T18:00:00.000Z");

  it("works once per person by default", async () => {
    send.mockResolvedValue({ Attributes: { ...row, invitedAt: at.toISOString() } });
    await expect(claimInvite(7, at)).resolves.toMatchObject({ invitedAt: at.toISOString() });
    const input = send.mock.calls[0]![0].input;
    expect(input.ConditionExpression).toBe("attribute_exists(PK) AND attribute_not_exists(invitedAt)");
    expect(input.ExpressionAttributeValues[":cutoff"]).toBeUndefined();
  });

  it("allows another send after a day when asked", async () => {
    send.mockResolvedValue({ Attributes: { ...row, invitedAt: at.toISOString() } });
    await claimInvite(7, at, { again: true });
    const input = send.mock.calls[0]![0].input;
    expect(input.ConditionExpression).toContain("invitedAt < :cutoff");
    expect(input.ExpressionAttributeValues[":cutoff"]).toBe("2026-11-03T18:00:00.000Z");
  });

  it("returns nothing when the guard says no", async () => {
    send.mockRejectedValue(ccf);
    await expect(claimInvite(7, at, { again: true })).resolves.toBeUndefined();
  });

  it("lets real errors through", async () => {
    send.mockRejectedValue(new Error("throttled"));
    await expect(claimInvite(7, at)).rejects.toThrow("throttled");
  });
});

describe("listPending", () => {
  it("reads every page and skips unreadable rows", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    send
      .mockResolvedValueOnce({ Items: [{ ...row, PK: "PORTAL#PENDING", SK: "APP#7" }, { SK: "APP#8" }], LastEvaluatedKey: { PK: "x" } })
      .mockResolvedValueOnce({ Items: [{ ...row, applicationId: 9 }] });
    const rows = await listPending();
    warn.mockRestore();
    expect(rows.map((r) => r.applicationId)).toEqual([7, 9]);
  });
});
