import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sendMock = vi.hoisted(() => vi.fn());

vi.mock("../lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/db")>();
  return {
    ...actual,
    getDocClient: () => ({ send: sendMock }),
  };
});

import { handler } from "./share";

async function invoke(event: Record<string, unknown>) {
  const result = await handler(event as never, {} as never, () => undefined);
  if (result === undefined || typeof result === "string") {
    throw new Error("expected a structured APIGatewayProxyStructuredResultV2");
  }
  return result;
}

/** `sub: null` builds an event whose JWT carries no sub claim. */
const shareEvent = (method = "POST", sub: string | null = "u-1", contentId = "c-floor-routine") => ({
  pathParameters: { contentId },
  requestContext: {
    http: { method },
    authorizer: { jwt: { claims: sub === null ? {} : { sub } } },
  },
});

const contentItem = { PK: "CONTENT#c-floor-routine", SK: "META", id: "c-floor-routine", shares: 2 };

/** The TransactionCanceledException the SDK throws when a condition trips. */
function conditionalCheckError() {
  return Object.assign(new Error("Transaction cancelled"), {
    name: "TransactionCanceledException",
    CancellationReasons: [{ Code: "ConditionalCheckFailed" }, { Code: "None" }],
  });
}

describe("POST /v1/me/shares/{contentId} handler", () => {
  beforeEach(() => {
    sendMock.mockReset();
    process.env.TABLE_NAME = "niltv-test";
    delete process.env.ORIGIN_VERIFY_SECRET;
  });

  afterEach(() => {
    delete process.env.ORIGIN_VERIFY_SECRET;
    vi.restoreAllMocks();
  });

  it("returns 403 without the origin-verify header when a secret is configured", async () => {
    process.env.ORIGIN_VERIFY_SECRET = "s3cret";
    const res = await invoke(shareEvent());
    expect(res.statusCode).toBe(403);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("returns 401 when the JWT sub claim is missing", async () => {
    const res = await invoke(shareEvent("POST", null));
    expect(res.statusCode).toBe(401);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("returns 405 for any method but POST", async () => {
    const res = await invoke(shareEvent("DELETE"));
    expect(res.statusCode).toBe(405);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("returns 404 when the content row does not exist", async () => {
    sendMock.mockResolvedValueOnce({});
    const res = await invoke(shareEvent());
    expect(res.statusCode).toBe(404);
    expect(sendMock).toHaveBeenCalledTimes(1); // existence check only, no transaction
  });

  it("returns 404 for a tombstoned clip, so a removed post never collects shares", async () => {
    sendMock.mockResolvedValueOnce({
      Item: { ...contentItem, removed: true, removedAt: "2026-09-04T00:00:00Z", removedReason: "test" },
    });
    const res = await invoke(shareEvent());
    expect(res.statusCode).toBe(404);
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it("writes the share row + counter in one conditional transaction and acks the new count", async () => {
    sendMock
      .mockResolvedValueOnce({ Item: contentItem })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Item: { shares: 3 } });

    const res = await invoke(shareEvent());

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body ?? "")).toEqual({ status: "ok", shares: 3 });
    expect(sendMock).toHaveBeenCalledTimes(3);

    const transact = (sendMock.mock.calls[1]?.[0] as { input: Record<string, unknown> }).input;
    const [fact, counter] = transact["TransactItems"] as [Record<string, any>, Record<string, any>];
    expect(fact.Put.Item).toMatchObject({ PK: "USER#u-1", SK: "SHARE#c-floor-routine" });
    expect(fact.Put.Item.GSI1PK).toBeUndefined();
    expect(fact.Put.ConditionExpression).toBe("attribute_not_exists(PK)");
    expect(counter.Update).toMatchObject({
      Key: { PK: "CONTENT#c-floor-routine", SK: "META" },
      UpdateExpression: "ADD shares :one",
      ConditionExpression: "attribute_not_exists(#removed)",
      ExpressionAttributeNames: { "#removed": "removed" },
      ExpressionAttributeValues: { ":one": 1 },
    });

    const readBack = (sendMock.mock.calls[2]?.[0] as { input: Record<string, unknown> }).input;
    expect(readBack).toMatchObject({ ProjectionExpression: "shares", ConsistentRead: true });
  });

  it("is idempotent: a repeat share acks ok with the unchanged count", async () => {
    sendMock
      .mockResolvedValueOnce({ Item: contentItem })
      .mockRejectedValueOnce(conditionalCheckError())
      .mockResolvedValueOnce({ Item: { shares: 2 } });

    const res = await invoke(shareEvent());

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body ?? "")).toEqual({ status: "ok", shares: 2 });
  });

  it("reports shares: 0 for a clip with no counter attribute, and clamps a negative one", async () => {
    sendMock
      .mockResolvedValueOnce({ Item: contentItem })
      .mockRejectedValueOnce(conditionalCheckError())
      .mockResolvedValueOnce({ Item: {} });
    expect(JSON.parse((await invoke(shareEvent())).body ?? "")).toEqual({ status: "ok", shares: 0 });

    sendMock.mockReset();
    sendMock
      .mockResolvedValueOnce({ Item: contentItem })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Item: { shares: -1 } });
    expect(JSON.parse((await invoke(shareEvent())).body ?? "")).toEqual({ status: "ok", shares: 0 });
  });

  it("acks ok without a count when the read-back fails after the write", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    sendMock
      .mockResolvedValueOnce({ Item: contentItem })
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error("throttled"));

    const res = await invoke(shareEvent());

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body ?? "")).toEqual({ status: "ok" });
    expect(errorSpy).toHaveBeenCalled();
  });

  it("rethrows a transaction failure that is not a condition check", async () => {
    sendMock
      .mockResolvedValueOnce({ Item: contentItem })
      .mockRejectedValueOnce(new Error("ProvisionedThroughputExceeded"));
    await expect(invoke(shareEvent())).rejects.toThrow("ProvisionedThroughputExceeded");
  });
});
