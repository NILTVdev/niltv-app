import { beforeEach, describe, expect, it, vi } from "vitest";

const sendMock = vi.hoisted(() => vi.fn());

vi.mock("../lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/db")>();
  return {
    ...actual,
    getDocClient: () => ({ send: sendMock }),
  };
});

import { handler } from "./notification-follows";

async function invoke(event: Record<string, unknown>) {
  const result = await handler(event as never, {} as never, () => undefined);
  if (result === undefined || typeof result === "string") {
    throw new Error("expected a structured APIGatewayProxyStructuredResultV2");
  }
  return result;
}

const makeEvent = (body: unknown, sub: string | null = "u-1") => ({
  body: body === undefined ? undefined : JSON.stringify(body),
  requestContext: {
    http: { method: "PUT" },
    authorizer: { jwt: { claims: sub === null ? {} : { sub } } },
  },
});

describe("PUT /v1/me/notification-follows handler", () => {
  beforeEach(() => {
    sendMock.mockReset();
    sendMock.mockResolvedValue({});
    process.env.TABLE_NAME = "niltv-test";
    delete process.env.ORIGIN_VERIFY_SECRET;
  });

  it("returns 401 when the JWT sub claim is missing", async () => {
    const res = await invoke(makeEvent({ follows: [] }, null));
    expect(res.statusCode).toBe(401);
  });

  it("rejects a malformed body", async () => {
    const res = await invoke(makeEvent({ follows: [{ targetType: "nope", targetId: "x" }] }));
    expect(res.statusCode).toBe(400);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("replaces: deletes rows not in the payload, writes new ones with the TARGET mirror", async () => {
    // Currently opted into channel ch-tbtv and ambassador ath-old.
    sendMock.mockResolvedValueOnce({
      Items: [{ SK: "NOTIF#channel#ch-tbtv" }, { SK: "NOTIF#ambassador#ath-old" }],
    });

    const res = await invoke(
      makeEvent({
        follows: [
          { targetType: "channel", targetId: "ch-tbtv" }, // kept — no rewrite
          { targetType: "ambassador", targetId: "ath-new" }, // added
        ],
      }),
    );

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body ?? "")).toEqual({ status: "ok" });

    const batch = (sendMock.mock.calls[1]?.[0] as { input: Record<string, any> }).input;
    const writes = batch["RequestItems"]["niltv-test"] as Array<Record<string, any>>;
    expect(writes).toHaveLength(2);

    const del = writes.find((w) => w["DeleteRequest"]);
    expect(del?.["DeleteRequest"].Key).toEqual({ PK: "USER#u-1", SK: "NOTIF#ambassador#ath-old" });

    const put = writes.find((w) => w["PutRequest"]);
    expect(put?.["PutRequest"].Item).toMatchObject({
      PK: "USER#u-1",
      SK: "NOTIF#ambassador#ath-new",
      GSI1PK: "TARGET#ambassador#ath-new",
      GSI1SK: "USER#u-1",
    });
  });

  it("an empty payload clears every opt-in", async () => {
    sendMock.mockResolvedValueOnce({ Items: [{ SK: "NOTIF#channel#ch-tbtv" }] });
    const res = await invoke(makeEvent({ follows: [] }));
    expect(res.statusCode).toBe(200);
    const batch = (sendMock.mock.calls[1]?.[0] as { input: Record<string, any> }).input;
    const writes = batch["RequestItems"]["niltv-test"] as Array<Record<string, any>>;
    expect(writes).toHaveLength(1);
    expect(writes[0]?.["DeleteRequest"]).toBeTruthy();
  });

  it("a no-change payload issues no batch write at all", async () => {
    sendMock.mockResolvedValueOnce({ Items: [{ SK: "NOTIF#channel#ch-tbtv" }] });
    const res = await invoke(makeEvent({ follows: [{ targetType: "channel", targetId: "ch-tbtv" }] }));
    expect(res.statusCode).toBe(200);
    expect(sendMock).toHaveBeenCalledTimes(1); // the read only
  });
});
