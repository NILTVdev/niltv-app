import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sendMock = vi.hoisted(() => vi.fn());

vi.mock("../lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/db")>();
  return {
    ...actual,
    getDocClient: () => ({ send: sendMock }),
  };
});

import { VOTE_TRANSACTION_ATTEMPTS } from "../lib/db";
import { handler } from "./vote";

async function invoke(event: Record<string, unknown>) {
  const result = await handler(event as never, {} as never, () => undefined);
  if (result === undefined || typeof result === "string") {
    throw new Error("expected a structured APIGatewayProxyStructuredResultV2");
  }
  return result;
}

interface VoteEventOpts {
  /** null → omit the claim entirely */
  sub?: string | null;
  /** null → omit the claim entirely */
  is18plus?: string | null;
  eventId?: string;
  /** null → no request body */
  body?: string | null;
}

/** JWT-authorized POST /v1/events/{eventId}/vote; defaults model the happy path. */
const voteEvent = (opts: VoteEventOpts = {}) => {
  const { sub = "u-1", is18plus = "true", eventId = "ev-nilstar", body = JSON.stringify({ entryId: "en-1" }) } = opts;
  const claims: Record<string, string> = {};
  if (sub !== null) claims["sub"] = sub;
  if (is18plus !== null) claims["custom:is18plus"] = is18plus;
  return {
    pathParameters: { eventId },
    ...(body === null ? {} : { body }),
    requestContext: {
      http: { method: "POST" },
      authorizer: { jwt: { claims } },
    },
  };
};

const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

/** A stored-live event whose window brackets now. */
const liveEvent = () => ({
  PK: "EVENT#ev-nilstar",
  SK: "META",
  id: "ev-nilstar",
  status: "live",
  startsAt: iso(-60_000),
  endsAt: iso(60_000),
});

const entryRow = { PK: "EVENT#ev-nilstar", SK: "ENTRY#en-1", id: "en-1", athleteId: "ath-a", votes: 7 };

function conditionalCheckError() {
  return Object.assign(new Error("Transaction cancelled"), {
    name: "TransactionCanceledException",
    CancellationReasons: [{ Code: "ConditionalCheckFailed" }, { Code: "None" }],
  });
}

describe("POST /v1/events/{eventId}/vote handler", () => {
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
    const res = await invoke(voteEvent({ sub: null }));
    expect(res.statusCode).toBe(401);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("returns 403 AGE_GATE when the is18plus claim is absent (fail closed)", async () => {
    const res = await invoke(voteEvent({ is18plus: null }));
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body ?? "")).toEqual({ error: "AGE_GATE" });
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('returns 403 AGE_GATE when the claim is "false"', async () => {
    const res = await invoke(voteEvent({ is18plus: "false" }));
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body ?? "")).toEqual({ error: "AGE_GATE" });
  });

  it("returns 400 INVALID_ENTRY for a missing/unparseable body", async () => {
    const res = await invoke(voteEvent({ body: null }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body ?? "")).toMatchObject({ error: "INVALID_ENTRY" });
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("returns 404 when the event does not exist", async () => {
    sendMock.mockResolvedValueOnce({});
    const res = await invoke(voteEvent());
    expect(res.statusCode).toBe(404);
  });

  it("returns 409 WINDOW_CLOSED when the stored status is not live", async () => {
    sendMock.mockResolvedValueOnce({ Item: { ...liveEvent(), status: "upcoming" } });
    const res = await invoke(voteEvent());
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body ?? "")).toEqual({ error: "WINDOW_CLOSED" });
    expect(sendMock).toHaveBeenCalledTimes(1); // no entry read, no transaction
  });

  it("returns 409 WINDOW_CLOSED when now is past endsAt even if status is still live", async () => {
    sendMock.mockResolvedValueOnce({
      Item: { ...liveEvent(), startsAt: iso(-120_000), endsAt: iso(-60_000) },
    });
    const res = await invoke(voteEvent());
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body ?? "")).toEqual({ error: "WINDOW_CLOSED" });
  });

  it("returns 400 INVALID_ENTRY when the entry is not in this event", async () => {
    sendMock.mockResolvedValueOnce({ Item: liveEvent() }).mockResolvedValueOnce({});
    const res = await invoke(voteEvent());
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body ?? "")).toMatchObject({ error: "INVALID_ENTRY" });
    expect(sendMock).toHaveBeenCalledTimes(2); // no transaction
  });

  it("201: writes the conditional Vote fact row (with GSI mirror) + counter ADD in one transaction", async () => {
    sendMock
      .mockResolvedValueOnce({ Item: liveEvent() })
      .mockResolvedValueOnce({ Item: entryRow })
      .mockResolvedValueOnce({});

    const res = await invoke(voteEvent());

    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body ?? "")).toEqual({ status: "ok", eventId: "ev-nilstar", entryId: "en-1" });

    const transact = (sendMock.mock.calls[2]?.[0] as { input: Record<string, unknown> }).input;
    const [fact, counter] = transact["TransactItems"] as [Record<string, any>, Record<string, any>];
    expect(fact.Put.Item).toMatchObject({
      PK: "USER#u-1",
      SK: "VOTE#ev-nilstar",
      GSI1PK: "EVENT#ev-nilstar",
      GSI1SK: "VOTE#en-1#u-1",
      eventId: "ev-nilstar",
      entryId: "en-1",
      source: "app",
    });
    expect(fact.Put.ConditionExpression).toBe("attribute_not_exists(PK)");
    expect(counter.Update).toMatchObject({
      Key: { PK: "EVENT#ev-nilstar", SK: "ENTRY#en-1" },
      UpdateExpression: "ADD votes :one",
      ExpressionAttributeValues: { ":one": 1 },
    });
  });

  it("returns 409 ALREADY_VOTED on the condition check — the counter did not move", async () => {
    sendMock
      .mockResolvedValueOnce({ Item: liveEvent() })
      .mockResolvedValueOnce({ Item: entryRow })
      .mockRejectedValueOnce(conditionalCheckError());

    const res = await invoke(voteEvent());
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body ?? "")).toEqual({ error: "ALREADY_VOTED" });
  });

  it("retries a hot-counter TransactionConflict and still lands the vote", async () => {
    const conflict = () =>
      Object.assign(new Error("Transaction cancelled"), {
        name: "TransactionCanceledException",
        CancellationReasons: [{ Code: "None" }, { Code: "TransactionConflict" }],
      });
    sendMock
      .mockResolvedValueOnce({ Item: liveEvent() })
      .mockResolvedValueOnce({ Item: entryRow })
      .mockRejectedValueOnce(conflict())
      .mockRejectedValueOnce(conflict())
      .mockResolvedValueOnce({});

    const res = await invoke(voteEvent());
    expect(res.statusCode).toBe(201);
    expect(sendMock).toHaveBeenCalledTimes(5);
  });

  it("answers 503 BUSY after exhausting conflict retries, never 500", async () => {
    // A conflict means the transaction was cancelled — nothing was written, so
    // the voter can simply tap again. Surfacing it as an unhandled throw (500)
    // trips the API 5xx alarm as an outage and reads to the client as a broken
    // vote path.
    const conflict = () =>
      Object.assign(new Error("Transaction cancelled"), {
        name: "TransactionCanceledException",
        CancellationReasons: [{ Code: "TransactionConflict" }],
      });
    sendMock.mockResolvedValueOnce({ Item: liveEvent() }).mockResolvedValueOnce({ Item: entryRow });
    for (let i = 0; i < VOTE_TRANSACTION_ATTEMPTS; i++) sendMock.mockRejectedValueOnce(conflict());

    const res = await invoke(voteEvent());
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body as string).error).toBe("BUSY");
  });

  it("retries a conflict and succeeds without the caller ever seeing it", async () => {
    const conflict = () =>
      Object.assign(new Error("Transaction cancelled"), {
        name: "TransactionCanceledException",
        CancellationReasons: [{ Code: "TransactionConflict" }],
      });
    sendMock
      .mockResolvedValueOnce({ Item: liveEvent() })
      .mockResolvedValueOnce({ Item: entryRow })
      .mockRejectedValueOnce(conflict())
      .mockRejectedValueOnce(conflict())
      .mockResolvedValueOnce({});

    const res = await invoke(voteEvent());
    expect(res.statusCode).toBe(201);
  });

  it("rethrows transaction failures that are neither the condition check nor a conflict", async () => {
    sendMock
      .mockResolvedValueOnce({ Item: liveEvent() })
      .mockResolvedValueOnce({ Item: entryRow })
      .mockRejectedValueOnce(
        Object.assign(new Error("throttled"), {
          name: "ProvisionedThroughputExceededException",
        }),
      );

    await expect(invoke(voteEvent())).rejects.toThrow("throttled");
  });

  it("rejects requests missing the origin-verify header when the secret is set", async () => {
    process.env.ORIGIN_VERIFY_SECRET = "shh";
    const res = await invoke(voteEvent());
    expect(res.statusCode).toBe(403);
    expect(sendMock).not.toHaveBeenCalled();
  });
});
