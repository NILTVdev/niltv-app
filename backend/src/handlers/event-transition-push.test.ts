/**
 * Lifecycle pushes (design §7) — separated from event-transition.test.ts so
 * the push lib can be fully mocked: these tests pin WHO gets notified on each
 * boundary and that push failures never fail a committed transition.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const sendMock = vi.hoisted(() => vi.fn());
const broadcastPushMock = vi.hoisted(() => vi.fn());
const listVoterUserIdsMock = vi.hoisted(() => vi.fn());
const pushToUsersMock = vi.hoisted(() => vi.fn());

vi.mock("../lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/db")>();
  return {
    ...actual,
    getDocClient: () => ({ send: sendMock }),
  };
});

vi.mock("../lib/push", () => ({
  broadcastPush: broadcastPushMock,
  listVoterUserIds: listVoterUserIdsMock,
  pushToUsers: pushToUsersMock,
}));

import { handler, notifyClosingSoon, transitionEvent } from "./event-transition";

const eventRow = (status: string, endsAt = "2026-09-25T00:00:00.000Z") => ({
  PK: "EVENT#ev-x",
  SK: "META",
  id: "ev-x",
  title: "NIL STAR S2",
  status,
  startsAt: "2026-09-07T00:00:00.000Z",
  endsAt,
});

describe("transition pushes (design §7)", () => {
  beforeEach(() => {
    sendMock.mockReset();
    sendMock.mockResolvedValue({});
    broadcastPushMock.mockReset();
    broadcastPushMock.mockResolvedValue({ sent: 5, pruned: 0 });
    listVoterUserIdsMock.mockReset();
    pushToUsersMock.mockReset();
    pushToUsersMock.mockResolvedValue({ sent: 3, pruned: 0 });
    process.env.TABLE_NAME = "niltv-test";
    delete process.env.DISTRIBUTION_ID;
  });

  it("→ live broadcasts voting-open with the event deep link", async () => {
    sendMock.mockResolvedValueOnce({ Item: eventRow("upcoming") }).mockResolvedValue({});
    expect(await transitionEvent("ev-x", "live")).toBe("ok");
    const [notification] = broadcastPushMock.mock.calls[0] as [Record<string, any>];
    expect(notification.body).toContain("NIL STAR S2");
    expect(notification.data).toEqual({ url: "/event/ev-x" });
    expect(pushToUsersMock).not.toHaveBeenCalled();
  });

  it("→ ended pushes results to the voters only", async () => {
    sendMock
      .mockResolvedValueOnce({ Item: eventRow("live") })
      .mockResolvedValueOnce({ Items: [] }) // entries for the recap snapshot
      .mockResolvedValue({});
    listVoterUserIdsMock.mockResolvedValue(["u-1", "u-2"]);

    expect(await transitionEvent("ev-x", "ended")).toBe("ok");

    expect(broadcastPushMock).not.toHaveBeenCalled();
    const [audience, notification] = pushToUsersMock.mock.calls[0] as [Set<string>, Record<string, any>];
    expect([...audience].sort()).toEqual(["u-1", "u-2"]);
    expect(notification.title).toContain("results");
  });

  it("a push outage never fails a committed transition", async () => {
    sendMock.mockResolvedValueOnce({ Item: eventRow("upcoming") }).mockResolvedValue({});
    broadcastPushMock.mockRejectedValue(new Error("expo down"));
    expect(await transitionEvent("ev-x", "live")).toBe("ok");
  });

  it("closingSoon broadcasts only while the event is still live with time left", async () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    sendMock.mockResolvedValueOnce({ Item: eventRow("live", future) });
    expect(await notifyClosingSoon("ev-x")).toBe("ok");
    const [notification] = broadcastPushMock.mock.calls[0] as [Record<string, any>];
    expect(notification.data).toEqual({ url: "/event/ev-x" });
  });

  it("closingSoon is a no-op for ended/rescheduled events (stale one-shot guard)", async () => {
    sendMock.mockResolvedValueOnce({ Item: eventRow("ended") });
    expect(await notifyClosingSoon("ev-x")).toBe("noop");

    sendMock.mockResolvedValueOnce({ Item: eventRow("live", "2020-01-01T00:00:00.000Z") });
    expect(await notifyClosingSoon("ev-x")).toBe("noop");

    expect(broadcastPushMock).not.toHaveBeenCalled();
  });

  it("the scheduler entrypoint routes the notify payload to closingSoon", async () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    sendMock.mockResolvedValueOnce({ Item: eventRow("live", future) });
    expect(await handler({ eventId: "ev-x", notify: "closingSoon" })).toBe("ok");
    expect(broadcastPushMock).toHaveBeenCalledTimes(1);
  });
});
