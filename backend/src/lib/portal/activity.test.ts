import { NotifyPrefs, type PortalMember } from "@niltv/types";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sendMock = vi.hoisted(() => vi.fn());

vi.mock("../db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../db")>()),
  getDocClient: () => ({ send: sendMock }),
  backoffDelayMs: () => 0,
}));

import { claimPushSlot, queueSummary, settleSummary } from "./activity";

const ccf = Object.assign(new Error("conditional"), { name: "ConditionalCheckFailedException" });

const member: PortalMember = {
  sub: "u-1",
  email: "a@example.com",
  name: "Jordan M.",
  role: "athlete",
  status: "active",
  desks: [],
  edited: [],
  notify: NotifyPrefs.parse({}),
  createdAt: "2026-10-01T00:00:00.000Z",
  timezone: "America/New_York",
};

beforeEach(() => {
  sendMock.mockReset();
  process.env.TABLE_NAME = "niltv-test";
});

describe("queueSummary", () => {
  it("writes the pending summary into the due index, guarded by rev", async () => {
    sendMock.mockResolvedValueOnce({}).mockResolvedValueOnce({});
    await queueSummary(member, { at: new Date("2026-10-21T19:00:00.000Z"), cadence: "now" });
    const update = sendMock.mock.calls[1]![0].input;
    expect(update.ConditionExpression).toBe("attribute_not_exists(rev) OR rev = :rev");
    expect(update.ExpressionAttributeValues).toMatchObject({
      ":pk": "NOTIFY#DUE",
      ":due": "2026-10-21T20:00:00.000Z",
      ":next": 1,
    });
  });

  it("re-reads and retries when another notice wrote first", async () => {
    sendMock
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(ccf)
      .mockResolvedValueOnce({ Item: { rev: 1, pendingSince: "2026-10-21T18:50:00.000Z", dueAt: "2026-10-21T19:50:00.000Z", notes: [] } })
      .mockResolvedValueOnce({});
    await queueSummary(member, { at: new Date("2026-10-21T19:00:00.000Z"), cadence: "now" });
    const retry = sendMock.mock.calls[3]![0].input;
    expect(retry.ConditionExpression).toBe("rev = :rev");
    // The earlier activity's due time stands.
    expect(retry.ExpressionAttributeValues).toMatchObject({ ":rev": 1, ":next": 2, ":due": "2026-10-21T19:50:00.000Z" });
  });
});

describe("settleSummary", () => {
  it("still records a sent summary when new activity landed meanwhile", async () => {
    sendMock.mockRejectedValueOnce(ccf).mockResolvedValueOnce({});
    const settled = await settleSummary("u-1", 3, { action: "sent", at: new Date("2026-10-21T19:00:00.000Z"), ignored: 1 });
    expect(settled).toBe(false);
    expect(sendMock.mock.calls[1]![0].input.UpdateExpression).toBe("SET lastSummaryAt = :at, ignored = :ignored");
  });
});

describe("claimPushSlot", () => {
  it("counts within the day", async () => {
    sendMock.mockResolvedValueOnce({});
    expect(await claimPushSlot("u-1", "2026-10-21")).toBe(true);
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it("starts a new day's count", async () => {
    sendMock.mockRejectedValueOnce(ccf).mockResolvedValueOnce({});
    expect(await claimPushSlot("u-1", "2026-10-22")).toBe(true);
    expect(sendMock.mock.calls[1]![0].input.UpdateExpression).toBe("SET pushDay = :day, pushCount = :one");
  });

  it("refuses once today's cap is used", async () => {
    sendMock.mockRejectedValueOnce(ccf).mockRejectedValueOnce(ccf);
    expect(await claimPushSlot("u-1", "2026-10-21")).toBe(false);
  });
});
