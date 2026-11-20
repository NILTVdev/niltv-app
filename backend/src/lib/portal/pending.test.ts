import { beforeEach, describe, expect, it, vi } from "vitest";

const send = vi.hoisted(() => vi.fn());

vi.mock("../db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../db")>()),
  getDocClient: () => ({ send }),
}));

import { claimInvite, listPending, markInviteSent, releaseInvite, savePending } from "./pending";

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

  it("allows one send a day per person", async () => {
    send.mockResolvedValue({ Attributes: { ...row, invitedAt: at.toISOString() } });
    await expect(claimInvite(7, at)).resolves.toMatchObject({ invitedAt: at.toISOString() });
    const input = send.mock.calls[0]![0].input;
    expect(input.ConditionExpression).toContain("attribute_not_exists(invitedAt) OR invitedAt < :cutoff");
    expect(input.ExpressionAttributeValues[":cutoff"]).toBe("2026-11-03T18:00:00.000Z");
  });

  it("returns nothing when the guard says no", async () => {
    send.mockRejectedValue(ccf);
    await expect(claimInvite(7, at)).resolves.toBeUndefined();
  });

  it("lets real errors through", async () => {
    send.mockRejectedValue(new Error("throttled"));
    await expect(claimInvite(7, at)).rejects.toThrow("throttled");
  });
});

describe("releaseInvite", () => {
  const at = new Date("2026-11-04T18:00:00.000Z");

  it("only gives back this run's own claim", async () => {
    send.mockResolvedValue({});
    await releaseInvite(7, at);
    const input = send.mock.calls[0]![0].input;
    expect(input.UpdateExpression).toBe("REMOVE invitedAt");
    expect(input.ExpressionAttributeValues[":at"]).toBe(at.toISOString());
  });

  it("does nothing when someone else has claimed since", async () => {
    send.mockRejectedValue(ccf);
    await expect(releaseInvite(7, at)).resolves.toBeUndefined();
  });
});

describe("markInviteSent", () => {
  it("does nothing when the person joined while it was sending", async () => {
    send.mockRejectedValue(ccf);
    await expect(markInviteSent(7, new Date())).resolves.toBeUndefined();
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
