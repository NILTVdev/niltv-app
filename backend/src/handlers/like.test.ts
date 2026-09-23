import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sendMock = vi.hoisted(() => vi.fn());

vi.mock("../lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/db")>();
  return {
    ...actual,
    getDocClient: () => ({ send: sendMock }),
  };
});

import { handler } from "./like";

async function invoke(event: Record<string, unknown>) {
  const result = await handler(event as never, {} as never, () => undefined);
  if (result === undefined || typeof result === "string") {
    throw new Error("expected a structured APIGatewayProxyStructuredResultV2");
  }
  return result;
}

/** `sub: null` builds an event whose JWT carries no sub claim. */
const likeEvent = (method: string, sub: string | null = "u-1", contentId = "c-floor-routine") => ({
  pathParameters: { contentId },
  requestContext: {
    http: { method },
    authorizer: { jwt: { claims: sub === null ? {} : { sub } } },
  },
});

const contentItem = { PK: "CONTENT#c-floor-routine", SK: "META", id: "c-floor-routine", likes: 3 };

/**
 * The 200 path makes three db calls: existence Get, the transaction, then a
 * counter read-back whose value lands in the ack as `likes`.
 */
function expectCounterReadBack(calls: unknown[][]) {
  expect(calls).toHaveLength(3);
  const readBack = (calls[2]?.[0] as { input: Record<string, unknown> }).input;
  expect(readBack).toMatchObject({
    TableName: "niltv-test",
    Key: { PK: "CONTENT#c-floor-routine", SK: "META" },
    ProjectionExpression: "likes",
    ConsistentRead: true,
  });
}

/** The TransactionCanceledException the SDK throws when a condition trips. */
function conditionalCheckError() {
  return Object.assign(new Error("Transaction cancelled"), {
    name: "TransactionCanceledException",
    CancellationReasons: [{ Code: "ConditionalCheckFailed" }, { Code: "None" }],
  });
}

describe("POST/DELETE /v1/me/likes/{contentId} handler", () => {
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
    const res = await invoke(likeEvent("POST", null));
    expect(res.statusCode).toBe(401);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("returns 404 when the content row does not exist", async () => {
    sendMock.mockResolvedValueOnce({});
    const res = await invoke(likeEvent("POST"));
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body ?? "")).toEqual({ error: "NOT_FOUND" });
    expect(sendMock).toHaveBeenCalledTimes(1); // existence check only, no transaction
  });

  it("returns 404 for a tombstoned clip, so a removed post never collects likes", async () => {
    sendMock.mockResolvedValueOnce({
      Item: {
        PK: "CONTENT#c-floor-routine", SK: "META", id: "c-floor-routine",
        removed: true, removedAt: "2026-09-04T00:00:00Z", removedReason: "test",
      },
    });
    const res = await invoke(likeEvent("POST"));
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body ?? "")).toEqual({ error: "NOT_FOUND" });
    expect(sendMock).toHaveBeenCalledTimes(1); // no transaction
  });

  it("POST writes the like row + counter in one conditional transaction", async () => {
    sendMock
      .mockResolvedValueOnce({ Item: contentItem })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Item: { likes: 4 } });

    const res = await invoke(likeEvent("POST"));

    expect(res.statusCode).toBe(200);
    // The ack carries the post-write count, read back after the transaction.
    expect(JSON.parse(res.body ?? "")).toEqual({ status: "ok", likes: 4 });
    expect(res.headers?.["cache-control"]).toBeUndefined();
    expectCounterReadBack(sendMock.mock.calls);

    const transact = (sendMock.mock.calls[1]?.[0] as { input: Record<string, unknown> }).input;
    const [fact, counter] = transact["TransactItems"] as [Record<string, any>, Record<string, any>];
    expect(fact.Put.Item).toMatchObject({
      PK: "USER#u-1",
      SK: "LIKE#c-floor-routine",
    });
    // Like rows have no GSI mirror (design §5).
    expect(fact.Put.Item.GSI1PK).toBeUndefined();
    expect(fact.Put.ConditionExpression).toBe("attribute_not_exists(PK)");
    expect(counter.Update).toMatchObject({
      Key: { PK: "CONTENT#c-floor-routine", SK: "META" },
      UpdateExpression: "ADD likes :delta",
      // A tombstone never accumulates likes.
      ConditionExpression: "attribute_not_exists(#removed)",
      ExpressionAttributeNames: { "#removed": "removed" },
      ExpressionAttributeValues: { ":delta": 1 },
    });
  });

  it("POST is idempotent: ConditionalCheckFailed still returns ok without recounting", async () => {
    sendMock
      .mockResolvedValueOnce({ Item: contentItem })
      .mockRejectedValueOnce(conditionalCheckError())
      .mockResolvedValueOnce({ Item: { likes: 3 } });

    const res = await invoke(likeEvent("POST"));

    expect(res.statusCode).toBe(200);
    // Counter untouched, and the ack still reports the current count.
    expect(JSON.parse(res.body ?? "")).toEqual({ status: "ok", likes: 3 });
    expectCounterReadBack(sendMock.mock.calls);
  });

  it("DELETE mirrors with attribute_exists and a -1 counter", async () => {
    sendMock
      .mockResolvedValueOnce({ Item: contentItem })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Item: { likes: 2 } });

    const res = await invoke(likeEvent("DELETE"));

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body ?? "")).toEqual({ status: "ok", likes: 2 });
    expectCounterReadBack(sendMock.mock.calls);
    const transact = (sendMock.mock.calls[1]?.[0] as { input: Record<string, unknown> }).input;
    const [fact, counter] = transact["TransactItems"] as [Record<string, any>, Record<string, any>];
    expect(fact.Delete.Key).toEqual({ PK: "USER#u-1", SK: "LIKE#c-floor-routine" });
    expect(fact.Delete.ConditionExpression).toBe("attribute_exists(PK)");
    expect(counter.Update.ExpressionAttributeValues).toEqual({ ":delta": -1 });
    expect(counter.Update.ConditionExpression).toBe("attribute_not_exists(#removed)");
  });

  it("DELETE of a like that never existed is idempotent ok", async () => {
    sendMock
      .mockResolvedValueOnce({ Item: contentItem })
      .mockRejectedValueOnce(conditionalCheckError())
      .mockResolvedValueOnce({ Item: { likes: 3 } });

    const res = await invoke(likeEvent("DELETE"));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body ?? "")).toEqual({ status: "ok", likes: 3 });
    expectCounterReadBack(sendMock.mock.calls);
  });

  it("reports likes: 0 when the clip has no counter attribute yet", async () => {
    sendMock
      .mockResolvedValueOnce({ Item: { ...contentItem, likes: undefined } })
      .mockRejectedValueOnce(conditionalCheckError())
      .mockResolvedValueOnce({ Item: {} });

    const res = await invoke(likeEvent("DELETE"));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body ?? "")).toEqual({ status: "ok", likes: 0 });
  });

  it("clamps a drifted counter: a row that reads below zero acks likes: 0", async () => {
    sendMock
      .mockResolvedValueOnce({ Item: contentItem })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Item: { likes: -1 } });

    const res = await invoke(likeEvent("DELETE"));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body ?? "")).toEqual({ status: "ok", likes: 0 });
    expectCounterReadBack(sendMock.mock.calls);
  });

  it("acks ok without a count when the read-back fails after the write", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    sendMock
      .mockResolvedValueOnce({ Item: contentItem })
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(
        Object.assign(new Error("throttled"), { name: "ProvisionedThroughputExceededException" }),
      );

    const res = await invoke(likeEvent("POST"));
    expect(res.statusCode).toBe(200);
    // The like is committed; the client keeps its optimistic count.
    expect(JSON.parse(res.body ?? "")).toEqual({ status: "ok" });
    expect(errorSpy).toHaveBeenCalledOnce();
  });

  it("rejects unsupported methods with 405", async () => {
    const res = await invoke(likeEvent("PUT"));
    expect(res.statusCode).toBe(405);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("rethrows transaction failures that are not the condition check", async () => {
    sendMock
      .mockResolvedValueOnce({ Item: contentItem })
      .mockRejectedValueOnce(
        Object.assign(new Error("throttled"), {
          name: "TransactionCanceledException",
          CancellationReasons: [{ Code: "TransactionConflict" }, { Code: "None" }],
        }),
      );

    await expect(invoke(likeEvent("POST"))).rejects.toThrow("throttled");
  });
});
