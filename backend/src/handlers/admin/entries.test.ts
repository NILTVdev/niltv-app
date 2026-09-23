import { beforeEach, describe, expect, it, vi } from "vitest";

const sendMock = vi.hoisted(() => vi.fn());

vi.mock("../../lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/db")>();
  return {
    ...actual,
    getDocClient: () => ({ send: sendMock }),
  };
});

import { handler } from "./entries";

async function invoke(event: Record<string, unknown>) {
  const result = await handler(event as never, {} as never, () => undefined);
  if (result === undefined || typeof result === "string") {
    throw new Error("expected a structured APIGatewayProxyStructuredResultV2");
  }
  return result;
}

function entriesEvent(
  method: "POST" | "DELETE",
  opts: { staff?: boolean; body?: unknown; entryId?: string } = {},
) {
  const { staff = true, body, entryId } = opts;
  return {
    pathParameters: { id: "ev-x", ...(entryId ? { entryId } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    requestContext: {
      http: { method },
      authorizer: { jwt: { claims: staff ? { "cognito:groups": "[staff]" } : {} } },
    },
  };
}

const eventRow = { PK: "EVENT#ev-x", SK: "META", id: "ev-x" };
const profileRow = { PK: "ATHLETE#ath-camila", SK: "META", id: "ath-camila" };

function conditionalCheckFailed() {
  return Object.assign(new Error("The conditional request failed"), {
    name: "ConditionalCheckFailedException",
  });
}

describe("POST/DELETE /admin/events/{id}/entries — finalist roster", () => {
  beforeEach(() => {
    sendMock.mockReset();
    process.env.TABLE_NAME = "niltv-test";
  });

  it("denies non-staff", async () => {
    const res = await invoke(entriesEvent("POST", { staff: false, body: { athleteId: "ath-camila" } }));
    expect(res.statusCode).toBe(403);
  });

  it("400s when the athlete does not exist (no dangling finalists)", async () => {
    sendMock.mockResolvedValueOnce({ Item: eventRow }).mockResolvedValueOnce({});
    const res = await invoke(entriesEvent("POST", { body: { athleteId: "ath-ghost" } }));
    expect(res.statusCode).toBe(400);
  });

  it("creates a fresh entry at votes:0 with the athlete-run GSI mirror", async () => {
    sendMock
      .mockResolvedValueOnce({ Item: eventRow })
      .mockResolvedValueOnce({ Item: profileRow })
      .mockRejectedValueOnce(conditionalCheckFailed()) // update-in-place misses
      .mockResolvedValueOnce({});

    const res = await invoke(
      entriesEvent("POST", { body: { athleteId: "ath-camila", auditionContentId: "c-dunk" } }),
    );

    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body ?? "")).toEqual({
      id: "en-camila",
      eventId: "ev-x",
      athleteId: "ath-camila",
      auditionContentId: "c-dunk",
      votes: 0,
    });
    const put = (sendMock.mock.calls[3]?.[0] as { input: Record<string, any> }).input;
    expect(put.Item).toMatchObject({
      PK: "EVENT#ev-x",
      SK: "ENTRY#en-camila",
      GSI1PK: "ATHLETE#ath-camila",
      GSI1SK: "ENTRY#ev-x",
    });
  });

  it("re-posting the same athlete updates in place without touching the vote counter", async () => {
    sendMock
      .mockResolvedValueOnce({ Item: eventRow })
      .mockResolvedValueOnce({ Item: profileRow })
      .mockResolvedValueOnce({
        Attributes: {
          id: "en-camila",
          eventId: "ev-x",
          athleteId: "ath-camila",
          auditionContentId: "c-new",
          votes: 41,
        },
      });

    const res = await invoke(
      entriesEvent("POST", { body: { athleteId: "ath-camila", auditionContentId: "c-new" } }),
    );

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body ?? "").votes).toBe(41);
    const update = (sendMock.mock.calls[2]?.[0] as { input: Record<string, any> }).input;
    expect(update.UpdateExpression).not.toContain("votes");
  });

  it("DELETE removes an entry, 404s when it never existed", async () => {
    sendMock.mockResolvedValueOnce({});
    expect((await invoke(entriesEvent("DELETE", { entryId: "en-camila" }))).statusCode).toBe(200);

    sendMock.mockReset();
    sendMock.mockRejectedValueOnce(conditionalCheckFailed());
    expect((await invoke(entriesEvent("DELETE", { entryId: "en-ghost" }))).statusCode).toBe(404);
  });
});
