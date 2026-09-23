import { beforeEach, describe, expect, it, vi } from "vitest";

const sendMock = vi.hoisted(() => vi.fn());

vi.mock("../lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/db")>();
  return {
    ...actual,
    getDocClient: () => ({ send: sendMock }),
  };
});

import { handler } from "./push-settings";

async function invoke(event: Record<string, unknown>) {
  const result = await handler(event as never, {} as never, () => undefined);
  if (result === undefined || typeof result === "string") {
    throw new Error("expected a structured APIGatewayProxyStructuredResultV2");
  }
  return result;
}

const makeEvent = (path: string, body: unknown, sub: string | null = "u-1") => ({
  rawPath: path,
  body: body === undefined ? undefined : JSON.stringify(body),
  requestContext: {
    http: { method: path.endsWith("/push") ? "PUT" : "POST", path },
    authorizer: { jwt: { claims: sub === null ? {} : { sub } } },
  },
});

const conditionalCheckError = () =>
  Object.assign(new Error("no row"), { name: "ConditionalCheckFailedException" });

describe("POST /v1/me/devices · PUT /v1/me/push handler", () => {
  beforeEach(() => {
    sendMock.mockReset();
    sendMock.mockResolvedValue({});
    process.env.TABLE_NAME = "niltv-test";
    delete process.env.ORIGIN_VERIFY_SECRET;
  });

  it("returns 401 when the JWT sub claim is missing", async () => {
    const res = await invoke(makeEvent("/v1/me/devices", { expoPushToken: "t", platform: "ios" }, null));
    expect(res.statusCode).toBe(401);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("rejects a malformed device registration", async () => {
    const res = await invoke(makeEvent("/v1/me/devices", { platform: "ios" }));
    expect(res.statusCode).toBe(400);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("registers a device: pushEnabled on, then token row with the broadcast mirror", async () => {
    const res = await invoke(
      makeEvent("/v1/me/devices", { expoPushToken: "ExponentPushToken[abc]", platform: "ios" }),
    );
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body ?? "")).toEqual({ status: "ok" });

    const toggle = (sendMock.mock.calls[0]?.[0] as { input: Record<string, any> }).input;
    expect(toggle["Key"]).toEqual({ PK: "USER#u-1", SK: "META" });
    expect(toggle["ConditionExpression"]).toBe("attribute_exists(PK)");
    expect(toggle["ExpressionAttributeValues"]).toEqual({ ":enabled": true });

    const put = (sendMock.mock.calls[1]?.[0] as { input: Record<string, any> }).input;
    expect(put["Item"]).toMatchObject({
      PK: "USER#u-1",
      SK: "DEVICE#ExponentPushToken[abc]",
      GSI1PK: "DEVICES#ALL",
      GSI1SK: "USER#u-1#ExponentPushToken[abc]",
      platform: "ios",
    });
  });

  it("a deleted account's stale JWT cannot mint rows (404, no device write)", async () => {
    sendMock.mockRejectedValueOnce(conditionalCheckError());
    const res = await invoke(makeEvent("/v1/me/devices", { expoPushToken: "t", platform: "ios" }));
    expect(res.statusCode).toBe(404);
    expect(sendMock).toHaveBeenCalledTimes(1); // toggle attempt only
  });

  it("PUT /v1/me/push writes the global toggle", async () => {
    const res = await invoke(makeEvent("/v1/me/push", { enabled: false }));
    expect(res.statusCode).toBe(200);
    const update = (sendMock.mock.calls[0]?.[0] as { input: Record<string, any> }).input;
    expect(update["UpdateExpression"]).toBe("SET pushEnabled = :enabled");
    expect(update["ExpressionAttributeValues"]).toEqual({ ":enabled": false });
  });
});
