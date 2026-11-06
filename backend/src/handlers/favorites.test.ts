import { beforeEach, describe, expect, it, vi } from "vitest";

const sendMock = vi.hoisted(() => vi.fn());

vi.mock("../lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/db")>();
  return {
    ...actual,
    getDocClient: () => ({ send: sendMock }),
  };
});

import { handler } from "./favorites";

async function invoke(event: Record<string, unknown> = {}) {
  const result = await handler(event as never, {} as never, () => undefined);
  if (result === undefined || typeof result === "string") {
    throw new Error("expected a structured APIGatewayProxyStructuredResultV2");
  }
  return result;
}

const selections = {
  schools: [" Duke ", "duke", "Example State"],
  sports: ["soccer", "soccer", "basketball"],
  channels: ["ch-trueblue", "ch-trueblue"],
};

const makeEvent = (body: unknown, sub: string | null = "u-1") => ({
  body: body === undefined ? undefined : JSON.stringify(body),
  requestContext: {
    http: { method: "PUT" },
    authorizer: { jwt: { claims: sub === null ? {} : { sub } } },
  },
});

describe("PUT /v1/me/favorites handler", () => {
  beforeEach(() => {
    sendMock.mockReset();
    process.env.TABLE_NAME = "niltv-test";
    delete process.env.ORIGIN_VERIFY_SECRET;
  });

  it("deduplicates, persists on USER META, and returns the updated account", async () => {
    sendMock
      .mockResolvedValueOnce({ Item: { channelIds: ["ch-trueblue"] } })
      .mockResolvedValueOnce({ Responses: { "niltv-test": [{ id: "ch-trueblue" }] } })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        Items: [
          {
            PK: "USER#u-1", SK: "META", id: "u-1", name: "Test Fan", email: "fan@example.com",
            role: "fan", is18plus: true, pushEnabled: false, favorites: {
              schools: ["Duke", "Example State"], sports: ["soccer", "basketball"], channels: ["ch-trueblue"],
            },
          },
        ],
      });

    const res = await invoke(makeEvent({ ...selections, userId: "u-other" }));

    expect(res.statusCode).toBe(200);
    expect(res.headers?.["cache-control"]).toBe("private, no-store");
    expect(JSON.parse(res.body ?? "")).toMatchObject({
      userId: "u-1",
      favorites: {
        schools: ["Duke", "Example State"],
        sports: ["soccer", "basketball"],
        channels: ["ch-trueblue"],
      },
    });
    expect(sendMock).toHaveBeenCalledTimes(4);

    const batch = (sendMock.mock.calls[1]?.[0] as { input: Record<string, any> }).input;
    expect(batch.RequestItems["niltv-test"].Keys).toEqual([{ PK: "CHANNEL#ch-trueblue", SK: "META" }]);
    const update = (sendMock.mock.calls[2]?.[0] as { input: Record<string, any> }).input;
    expect(update).toMatchObject({
      TableName: "niltv-test",
      Key: { PK: "USER#u-1", SK: "META" },
      ConditionExpression: "attribute_exists(PK)",
      UpdateExpression: "SET favorites = :favorites",
      ExpressionAttributeValues: {
        ":favorites": {
          schools: ["Duke", "Example State"],
          sports: ["soccer", "basketball"],
          channels: ["ch-trueblue"],
        },
      },
    });
    const query = (sendMock.mock.calls[3]?.[0] as { input: Record<string, unknown> }).input;
    expect(query["ConsistentRead"]).toBe(true);
  });

  it("rejects malformed, empty, unsupported-sport, and oversized selections before writing", async () => {
    const invalid = [
      undefined,
      "{",
      { ...selections, schools: ["   "] },
      { ...selections, sports: ["not-a-sport"] },
      { ...selections, sports: ["none-visible"] },
      { ...selections, sports: ["multi-sport"] },
      { ...selections, schools: ["x".repeat(81)] },
      { ...selections, channels: Array.from({ length: 101 }, (_, index) => `ch-${index}`) },
    ];

    for (const body of invalid) {
      const res = await invoke(makeEvent(body));
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body ?? "")).toEqual({ error: "INVALID_REQUEST" });
    }
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("rejects channels missing from the channel catalog without persisting", async () => {
    sendMock
      .mockResolvedValueOnce({ Item: { channelIds: ["ch-missing"] } })
      .mockResolvedValueOnce({ Responses: { "niltv-test": [] } });
    const res = await invoke(makeEvent({ ...selections, channels: ["ch-missing"] }));
    expect(res.statusCode).toBe(400);
    expect(sendMock).toHaveBeenCalledTimes(2);
  });

  it("rejects an existing but inactive channel before reading its row", async () => {
    sendMock.mockResolvedValueOnce({ Item: { channelIds: ["ch-trueblue"] } });
    const res = await invoke(makeEvent({ ...selections, channels: ["ch-inactive"] }));
    expect(res.statusCode).toBe(400);
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it("returns 401 without a JWT subject and does not access storage", async () => {
    const res = await invoke(makeEvent(selections, null));
    expect(res.statusCode).toBe(401);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("returns 404 instead of creating favorites for a missing user", async () => {
    sendMock
      .mockResolvedValueOnce({ Item: { channelIds: ["ch-trueblue"] } })
      .mockResolvedValueOnce({ Responses: { "niltv-test": [{ id: "ch-trueblue" }] } })
      .mockRejectedValueOnce(Object.assign(new Error("missing user"), { name: "ConditionalCheckFailedException" }));

    const res = await invoke(makeEvent(selections));
    expect(res.statusCode).toBe(404);
    expect(sendMock).toHaveBeenCalledTimes(3);
  });
});