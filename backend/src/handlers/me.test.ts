import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sendMock = vi.hoisted(() => vi.fn());

vi.mock("../lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/db")>();
  return {
    ...actual,
    getDocClient: () => ({ send: sendMock }),
  };
});

import { handler } from "./me";

async function invoke(event: Record<string, unknown> = {}) {
  const result = await handler(event as never, {} as never, () => undefined);
  if (result === undefined || typeof result === "string") {
    throw new Error("expected a structured APIGatewayProxyStructuredResultV2");
  }
  return result;
}

const authedEvent = (sub: unknown = "u-1") => ({
  requestContext: { authorizer: { jwt: { claims: { sub } } } },
});

const partitionRows = [
  {
    PK: "USER#u-1", SK: "META", id: "u-1", name: "Test Fan", email: "fan@example.com",
    role: "fan", is18plus: true, pushEnabled: true, createdAt: "2026-07-01T00:00:00Z",
  },
  { PK: "USER#u-1", SK: "FOLLOW#ath-camila" },
  { PK: "USER#u-1", SK: "LIKE#c-floor-routine" },
  { PK: "USER#u-1", SK: "VOTE#evt-nilstar-s1", entryId: "ent-camila" },
  { PK: "USER#u-1", SK: "NOTIF#channel#ch-trueblue" },
];

describe("GET /v1/me handler", () => {
  beforeEach(() => {
    sendMock.mockReset();
    process.env.TABLE_NAME = "niltv-test";
    delete process.env.ORIGIN_VERIFY_SECRET;
  });

  afterEach(() => {
    delete process.env.ORIGIN_VERIFY_SECRET;
    vi.restoreAllMocks();
  });

  it("returns 401 UNAUTHORIZED when the JWT sub claim is missing", async () => {
    const res = await invoke({});
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body ?? "")).toEqual({ error: "UNAUTHORIZED" });
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("returns 401 when the sub claim is not a usable string", async () => {
    expect((await invoke(authedEvent(""))).statusCode).toBe(401);
    expect((await invoke(authedEvent(42))).statusCode).toBe(401);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("maps the USER partition into MeResponse and never caches it", async () => {
    sendMock.mockResolvedValueOnce({ Items: partitionRows });

    const res = await invoke(authedEvent());

    expect(res.statusCode).toBe(200);
    expect(res.headers?.["cache-control"]).toBe("private, no-store");
    expect(JSON.parse(res.body ?? "")).toEqual({
      userId: "u-1",
      name: "Test Fan",
      email: "fan@example.com",
      role: "fan",
      is18plus: true,
      pushEnabled: true,
      votes: { "evt-nilstar-s1": "ent-camila" },
      follows: ["ath-camila"],
      likes: ["c-floor-routine"],
      notificationFollows: [{ targetType: "channel", targetId: "ch-trueblue" }],
    });

    // The query is keyed to the caller's own partition.
    const input = (sendMock.mock.calls[0]?.[0] as { input: Record<string, unknown> }).input;
    expect(input["ExpressionAttributeValues"]).toEqual({ ":pk": "USER#u-1" });
  });

  it("follows LastEvaluatedKey across pages", async () => {
    sendMock
      .mockResolvedValueOnce({
        Items: partitionRows.slice(0, 2),
        LastEvaluatedKey: { PK: "USER#u-1", SK: "FOLLOW#ath-camila" },
      })
      .mockResolvedValueOnce({ Items: partitionRows.slice(2) });

    const res = await invoke(authedEvent());

    expect(res.statusCode).toBe(200);
    expect(sendMock).toHaveBeenCalledTimes(2);
    const secondInput = (sendMock.mock.calls[1]?.[0] as { input: Record<string, unknown> }).input;
    expect(secondInput["ExclusiveStartKey"]).toEqual({ PK: "USER#u-1", SK: "FOLLOW#ath-camila" });
    const body = JSON.parse(res.body ?? "");
    expect(body.follows).toEqual(["ath-camila"]);
    expect(body.votes).toEqual({ "evt-nilstar-s1": "ent-camila" });
  });

  it("returns 404 when the USER row is gone (deleted account, live JWT)", async () => {
    sendMock.mockResolvedValueOnce({ Items: [] });
    const res = await invoke(authedEvent());
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body ?? "")).toEqual({ error: "NOT_FOUND" });
  });
});
