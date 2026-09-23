import { beforeEach, describe, expect, it, vi } from "vitest";

const sendMock = vi.hoisted(() => vi.fn());

vi.mock("../../lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/db")>();
  return {
    ...actual,
    getDocClient: () => ({ send: sendMock }),
  };
});

import { handler } from "./event-audit";

async function invoke(event: Record<string, unknown>) {
  const result = await handler(event as never, {} as never, () => undefined);
  if (result === undefined || typeof result === "string") {
    throw new Error("expected a structured APIGatewayProxyStructuredResultV2");
  }
  return result;
}

const auditEvent = (staff = true) => ({
  pathParameters: { id: "ev-x" },
  requestContext: {
    http: { method: "GET" },
    authorizer: { jwt: { claims: staff ? { "cognito:groups": "[staff]" } : {} } },
  },
});

const entryRow = (id: string, votes: number) => ({ PK: "EVENT#ev-x", SK: `ENTRY#${id}`, id, votes });
const voteRow = (entryId: string, userId: string, source?: string) => ({
  PK: `USER#${userId}`,
  SK: "VOTE#ev-x",
  GSI1PK: "EVENT#ev-x",
  GSI1SK: `VOTE#${entryId}#${userId}`,
  entryId,
  createdAt: "2026-09-10T00:00:00.000Z",
  ...(source ? { source } : {}),
});

describe("GET /admin/events/{id}/audit — recomputed tally vs display counters", () => {
  beforeEach(() => {
    sendMock.mockReset();
    process.env.TABLE_NAME = "niltv-test";
  });

  it("denies non-staff", async () => {
    const res = await invoke(auditEvent(false));
    expect(res.statusCode).toBe(403);
  });

  it("404s when neither entries nor a META row exist", async () => {
    sendMock.mockResolvedValueOnce({ Items: [] }).mockResolvedValueOnce({ Items: [] });
    const res = await invoke(auditEvent());
    expect(res.statusCode).toBe(404);
  });

  it("matches counters against fact rows and exports every vote", async () => {
    sendMock
      .mockResolvedValueOnce({ Items: [entryRow("en-a", 2), entryRow("en-b", 1)] })
      .mockResolvedValueOnce({
        Items: [voteRow("en-a", "u-1"), voteRow("en-a", "u-2", "web"), voteRow("en-b", "u-3")],
      });

    const res = await invoke(auditEvent());
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body ?? "");
    expect(body.totalVotes).toBe(3);
    expect(body.countersMatch).toBe(true);
    expect(body.tallies).toEqual([
      { entryId: "en-a", counter: 2, factCount: 2, matches: true },
      { entryId: "en-b", counter: 1, factCount: 1, matches: true },
    ]);
    expect(body.votes).toContainEqual({
      entryId: "en-a",
      userId: "u-2",
      createdAt: "2026-09-10T00:00:00.000Z",
      source: "web",
    });
  });

  it("flags a drifted counter", async () => {
    sendMock
      .mockResolvedValueOnce({ Items: [entryRow("en-a", 5)] })
      .mockResolvedValueOnce({ Items: [voteRow("en-a", "u-1")] });

    const body = JSON.parse((await invoke(auditEvent())).body ?? "");
    expect(body.countersMatch).toBe(false);
    expect(body.tallies[0]).toEqual({ entryId: "en-a", counter: 5, factCount: 1, matches: false });
  });

  it("flags a fact row pointing at a deleted entry", async () => {
    sendMock
      .mockResolvedValueOnce({ Items: [entryRow("en-a", 1)] })
      .mockResolvedValueOnce({ Items: [voteRow("en-a", "u-1"), voteRow("en-gone", "u-2")] });

    const body = JSON.parse((await invoke(auditEvent())).body ?? "");
    expect(body.countersMatch).toBe(false);
  });

  it("follows GSI pagination across vote pages", async () => {
    sendMock
      .mockResolvedValueOnce({ Items: [entryRow("en-a", 2)] })
      .mockResolvedValueOnce({ Items: [voteRow("en-a", "u-1")], LastEvaluatedKey: { k: 1 } })
      .mockResolvedValueOnce({ Items: [voteRow("en-a", "u-2")] });

    const body = JSON.parse((await invoke(auditEvent())).body ?? "");
    expect(body.totalVotes).toBe(2);
    expect(body.countersMatch).toBe(true);
  });
});
