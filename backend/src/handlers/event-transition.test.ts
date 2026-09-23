import { beforeEach, describe, expect, it, vi } from "vitest";

const sendMock = vi.hoisted(() => vi.fn());
const cfSendMock = vi.hoisted(() => vi.fn());

vi.mock("../lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/db")>();
  return {
    ...actual,
    getDocClient: () => ({ send: sendMock }),
  };
});

vi.mock("@aws-sdk/client-cloudfront", () => ({
  CloudFrontClient: class {
    send = cfSendMock;
  },
  CreateInvalidationCommand: class {
    constructor(public readonly input: unknown) {}
  },
}));

import { handler, transitionEvent } from "./event-transition";

const eventRow = (status: string) => ({
  PK: "EVENT#ev-x",
  SK: "META",
  id: "ev-x",
  status,
  startsAt: "2026-09-07T00:00:00.000Z",
  endsAt: "2026-09-25T00:00:00.000Z",
});

describe("event-transition (design §6.5)", () => {
  beforeEach(() => {
    sendMock.mockReset();
    cfSendMock.mockReset();
    process.env.TABLE_NAME = "niltv-test";
    delete process.env.DISTRIBUTION_ID;
  });

  it("returns not-found for a missing event", async () => {
    sendMock.mockResolvedValueOnce({});
    expect(await transitionEvent("ev-x", "live")).toBe("not-found");
  });

  it("is idempotent: same-status transition is a noop with no write", async () => {
    sendMock.mockResolvedValueOnce({ Item: eventRow("live") });
    expect(await transitionEvent("ev-x", "live")).toBe("noop");
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it("scheduled transitions are forward-only: ended → live without force is a noop", async () => {
    sendMock.mockResolvedValueOnce({ Item: eventRow("ended") });
    expect(await transitionEvent("ev-x", "live")).toBe("noop");
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it("→ live: guarded status update rewrites GSI1SK, no recap", async () => {
    sendMock.mockResolvedValueOnce({ Item: eventRow("upcoming") }).mockResolvedValueOnce({});

    expect(await transitionEvent("ev-x", "live")).toBe("ok");

    const update = (sendMock.mock.calls[1]?.[0] as { input: Record<string, any> }).input;
    expect(update.Key).toEqual({ PK: "EVENT#ev-x", SK: "META" });
    expect(update.ConditionExpression).toBe("#status = :from");
    expect(update.UpdateExpression).toBe("SET #status = :to, GSI1SK = :gsi1sk");
    expect(update.ExpressionAttributeValues).toEqual({
      ":from": "upcoming",
      ":to": "live",
      ":gsi1sk": "live#2026-09-07T00:00:00.000Z",
    });
  });

  it("→ ended: freezes the leaderboard from the entry counters onto the event item", async () => {
    sendMock
      .mockResolvedValueOnce({ Item: eventRow("live") })
      .mockResolvedValueOnce({
        Items: [
          { id: "en-a", votes: 3 },
          { id: "en-b", votes: 9 },
        ],
      })
      .mockResolvedValueOnce({});

    expect(await transitionEvent("ev-x", "ended")).toBe("ok");

    // Entry query is scoped to the event partition's ENTRY# rows.
    const query = (sendMock.mock.calls[1]?.[0] as { input: Record<string, any> }).input;
    expect(query.ExpressionAttributeValues).toEqual({ ":pk": "EVENT#ev-x", ":entry": "ENTRY#" });

    const update = (sendMock.mock.calls[2]?.[0] as { input: Record<string, any> }).input;
    expect(update.UpdateExpression).toBe("SET #status = :to, GSI1SK = :gsi1sk, recap = :recap");
    expect(update.ExpressionAttributeValues[":recap"]).toMatchObject({
      championEntryId: "en-b",
      totals: { votes: 12, entries: 2, daysLive: 18 },
    });
  });

  it("→ ended with no entries still flips status, without a recap", async () => {
    sendMock
      .mockResolvedValueOnce({ Item: eventRow("live") })
      .mockResolvedValueOnce({ Items: [] })
      .mockResolvedValueOnce({});

    expect(await transitionEvent("ev-x", "ended")).toBe("ok");
    const update = (sendMock.mock.calls[2]?.[0] as { input: Record<string, any> }).input;
    expect(update.UpdateExpression).toBe("SET #status = :to, GSI1SK = :gsi1sk");
  });

  it("force permits the break-glass backwards move (ended → live)", async () => {
    sendMock.mockResolvedValueOnce({ Item: eventRow("ended") }).mockResolvedValueOnce({});
    expect(await transitionEvent("ev-x", "live", true)).toBe("ok");
  });

  it("invalidates the edge paths when DISTRIBUTION_ID is set — and survives invalidation failure", async () => {
    process.env.DISTRIBUTION_ID = "E123";
    sendMock.mockResolvedValueOnce({ Item: eventRow("upcoming") }).mockResolvedValueOnce({});
    cfSendMock.mockRejectedValueOnce(new Error("cf down"));

    expect(await transitionEvent("ev-x", "live")).toBe("ok");
    expect(cfSendMock).toHaveBeenCalledTimes(1);
  });

  it("skips CloudFront entirely when DISTRIBUTION_ID is unset", async () => {
    sendMock.mockResolvedValueOnce({ Item: eventRow("upcoming") }).mockResolvedValueOnce({});
    await transitionEvent("ev-x", "live");
    expect(cfSendMock).not.toHaveBeenCalled();
  });

  it("handler entrypoint validates the status and reports the result", async () => {
    sendMock.mockResolvedValueOnce({ Item: eventRow("live") });
    expect(await handler({ eventId: "ev-x", to: "live" })).toBe("noop");
    await expect(handler({ eventId: "ev-x", to: "nope" as never })).rejects.toThrow();
  });
});
