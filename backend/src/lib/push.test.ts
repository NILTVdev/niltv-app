import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sendMock = vi.hoisted(() => vi.fn());

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();
  return {
    ...actual,
    getDocClient: () => ({ send: sendMock }),
  };
});

import { allDevices, devicesForUsers, listTargetUserIds, sendPush } from "./push";

const fetchMock = vi.fn();

const deviceRow = (userId: string, token: string) => ({
  PK: `USER#${userId}`,
  SK: `DEVICE#${token}`,
  GSI1PK: "DEVICES#ALL",
  GSI1SK: `USER#${userId}#${token}`,
});

const userRow = (userId: string, pushEnabled: boolean) => ({
  PK: `USER#${userId}`,
  pushEnabled,
});

describe("push audience resolution (design §6.4/§7)", () => {
  beforeEach(() => {
    sendMock.mockReset();
    process.env.TABLE_NAME = "niltv-test";
  });

  it("listTargetUserIds parses userIds off the TARGET partition", async () => {
    sendMock.mockResolvedValueOnce({
      Items: [{ GSI1SK: "USER#u-1" }, { GSI1SK: "USER#u-2" }],
    });
    expect(await listTargetUserIds("channel", "ch-tbtv")).toEqual(["u-1", "u-2"]);
    const query = (sendMock.mock.calls[0]?.[0] as { input: Record<string, any> }).input;
    expect(query["ExpressionAttributeValues"]).toEqual({ ":pk": "TARGET#channel#ch-tbtv" });
  });

  it("devicesForUsers keeps only requested users whose global toggle is on", async () => {
    sendMock
      .mockResolvedValueOnce({
        Items: [deviceRow("u-1", "tok-1"), deviceRow("u-2", "tok-2"), deviceRow("u-3", "tok-3")],
      })
      .mockResolvedValueOnce({
        Responses: { "niltv-test": [userRow("u-1", true), userRow("u-2", false)] },
      });

    const devices = await devicesForUsers(new Set(["u-1", "u-2"]));
    expect(devices).toEqual([{ userId: "u-1", expoPushToken: "tok-1" }]);
  });

  it("allDevices is the broadcast audience, still toggle-filtered", async () => {
    sendMock
      .mockResolvedValueOnce({ Items: [deviceRow("u-1", "tok-1"), deviceRow("u-2", "tok-2")] })
      .mockResolvedValueOnce({
        Responses: { "niltv-test": [userRow("u-1", true), userRow("u-2", true)] },
      });
    expect(await allDevices()).toHaveLength(2);
  });
});

describe("sendPush delivery + receipt pruning (design §6.4)", () => {
  beforeEach(() => {
    sendMock.mockReset();
    sendMock.mockResolvedValue({});
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    process.env.TABLE_NAME = "niltv-test";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const jsonResponse = (body: unknown) => ({
    ok: true,
    json: () => Promise.resolve(body),
  });

  it("sends nothing for an empty device list", async () => {
    expect(await sendPush([], { title: "t", body: "b" })).toEqual({ sent: 0, pruned: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("prunes DeviceNotRegistered from tickets AND receipts", async () => {
    fetchMock
      // send: tok-dead errors immediately, tok-1/tok-2 get tickets
      .mockResolvedValueOnce(
        jsonResponse({
          data: [
            { status: "ok", id: "ticket-1" },
            { status: "error", details: { error: "DeviceNotRegistered" } },
            { status: "ok", id: "ticket-2" },
          ],
        }),
      )
      // receipts: ticket-2's device is gone too
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            "ticket-1": { status: "ok" },
            "ticket-2": { status: "error", details: { error: "DeviceNotRegistered" } },
          },
        }),
      );

    const result = await sendPush(
      [
        { userId: "u-1", expoPushToken: "tok-1" },
        { userId: "u-dead", expoPushToken: "tok-dead" },
        { userId: "u-2", expoPushToken: "tok-2" },
      ],
      { title: "New on NILTV", body: "clip", data: { url: "/video/c-1" } },
    );

    expect(result).toEqual({ sent: 1, pruned: 2 });

    // Both dead rows deleted in one batch write.
    const batch = (sendMock.mock.calls[0]?.[0] as { input: Record<string, any> }).input;
    const keys = (batch["RequestItems"]["niltv-test"] as Array<Record<string, any>>).map(
      (w) => w["DeleteRequest"].Key,
    );
    expect(keys).toContainEqual({ PK: "USER#u-dead", SK: "DEVICE#tok-dead" });
    expect(keys).toContainEqual({ PK: "USER#u-2", SK: "DEVICE#tok-2" });
  });

  it("chunks sends at 100 messages per Expo call", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: [] }));
    const devices = Array.from({ length: 150 }, (_, i) => ({
      userId: `u-${i}`,
      expoPushToken: `tok-${i}`,
    }));
    await sendPush(devices, { title: "t", body: "b" });
    // 2 send calls + 0 receipt calls (no tickets returned).
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstBody = JSON.parse((fetchMock.mock.calls[0]?.[1] as { body: string }).body) as unknown[];
    expect(firstBody).toHaveLength(100);
  });

  it("a transport failure throws (the caller decides retry semantics)", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 502 });
    await expect(
      sendPush([{ userId: "u-1", expoPushToken: "tok-1" }], { title: "t", body: "b" }),
    ).rejects.toThrow("HTTP 502");
  });
});
