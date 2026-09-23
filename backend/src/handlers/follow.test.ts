import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sendMock = vi.hoisted(() => vi.fn());

vi.mock("../lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/db")>();
  return {
    ...actual,
    getDocClient: () => ({ send: sendMock }),
  };
});

import { handler } from "./follow";

async function invoke(event: Record<string, unknown>) {
  const result = await handler(event as never, {} as never, () => undefined);
  if (result === undefined || typeof result === "string") {
    throw new Error("expected a structured APIGatewayProxyStructuredResultV2");
  }
  return result;
}

/** `sub: null` builds an event whose JWT carries no sub claim. */
const followEvent = (method: string, sub: string | null = "u-1", athleteId = "ath-camila") => ({
  pathParameters: { athleteId },
  requestContext: {
    http: { method },
    authorizer: { jwt: { claims: sub === null ? {} : { sub } } },
  },
});

const profileItem = { PK: "ATHLETE#ath-camila", SK: "META", id: "ath-camila", name: "Camila Garza" };

/** The TransactionCanceledException the SDK throws when a condition trips. */
function conditionalCheckError() {
  return Object.assign(new Error("Transaction cancelled"), {
    name: "TransactionCanceledException",
    CancellationReasons: [{ Code: "ConditionalCheckFailed" }, { Code: "None" }],
  });
}

describe("PUT/DELETE /v1/me/follows/{athleteId} handler", () => {
  beforeEach(() => {
    sendMock.mockReset();
    process.env.TABLE_NAME = "niltv-test";
    delete process.env.ORIGIN_VERIFY_SECRET;
  });

  afterEach(() => {
    delete process.env.ORIGIN_VERIFY_SECRET;
    vi.restoreAllMocks();
  });

  it("returns 401 when the JWT sub claim is missing", async () => {
    const res = await invoke(followEvent("PUT", null));
    expect(res.statusCode).toBe(401);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("returns 404 when the athlete profile does not exist", async () => {
    sendMock.mockResolvedValueOnce({});
    const res = await invoke(followEvent("PUT"));
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body ?? "")).toEqual({ error: "NOT_FOUND" });
    expect(sendMock).toHaveBeenCalledTimes(1); // profile check only, no transaction
  });

  it("PUT writes the follow row + counter in one conditional transaction", async () => {
    sendMock
      .mockResolvedValueOnce({ Item: profileItem })
      .mockResolvedValueOnce({});

    const res = await invoke(followEvent("PUT"));

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body ?? "")).toEqual({ status: "ok" });
    expect(res.headers?.["cache-control"]).toBeUndefined();

    const transact = (sendMock.mock.calls[1]?.[0] as { input: Record<string, unknown> }).input;
    const [fact, counter] = transact["TransactItems"] as [Record<string, any>, Record<string, any>];
    expect(fact.Put.Item).toMatchObject({
      PK: "USER#u-1",
      SK: "FOLLOW#ath-camila",
      GSI1PK: "ATHLETE#ath-camila",
      GSI1SK: "USER#u-1",
    });
    expect(fact.Put.ConditionExpression).toBe("attribute_not_exists(PK)");
    expect(counter.Update).toMatchObject({
      Key: { PK: "ATHLETE#ath-camila", SK: "META" },
      UpdateExpression: "ADD followers :delta",
      ExpressionAttributeValues: { ":delta": 1 },
    });
  });

  it("PUT is idempotent: ConditionalCheckFailed still returns ok without recounting", async () => {
    sendMock
      .mockResolvedValueOnce({ Item: profileItem })
      .mockRejectedValueOnce(conditionalCheckError());

    const res = await invoke(followEvent("PUT"));

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body ?? "")).toEqual({ status: "ok" });
  });

  it("DELETE mirrors with attribute_exists and a -1 counter", async () => {
    sendMock
      .mockResolvedValueOnce({ Item: profileItem })
      .mockResolvedValueOnce({});

    const res = await invoke(followEvent("DELETE"));

    expect(res.statusCode).toBe(200);
    const transact = (sendMock.mock.calls[1]?.[0] as { input: Record<string, unknown> }).input;
    const [fact, counter] = transact["TransactItems"] as [Record<string, any>, Record<string, any>];
    expect(fact.Delete.Key).toEqual({ PK: "USER#u-1", SK: "FOLLOW#ath-camila" });
    expect(fact.Delete.ConditionExpression).toBe("attribute_exists(PK)");
    expect(counter.Update.ExpressionAttributeValues).toEqual({ ":delta": -1 });
  });

  it("DELETE of a follow that never existed is idempotent ok", async () => {
    sendMock
      .mockResolvedValueOnce({ Item: profileItem })
      .mockRejectedValueOnce(conditionalCheckError());

    const res = await invoke(followEvent("DELETE"));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body ?? "")).toEqual({ status: "ok" });
  });

  it("rethrows transaction failures that are not the condition check", async () => {
    sendMock
      .mockResolvedValueOnce({ Item: profileItem })
      .mockRejectedValueOnce(
        Object.assign(new Error("throttled"), {
          name: "TransactionCanceledException",
          CancellationReasons: [{ Code: "TransactionConflict" }, { Code: "None" }],
        }),
      );

    await expect(invoke(followEvent("PUT"))).rejects.toThrow("throttled");
  });
});
