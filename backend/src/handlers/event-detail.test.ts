import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sendMock = vi.hoisted(() => vi.fn());

vi.mock("../lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/db")>();
  return {
    ...actual,
    getDocClient: () => ({ send: sendMock }),
  };
});

import { handler } from "./event-detail";

const TABLE = "niltv-test";

async function invoke(event: Record<string, unknown>) {
  const result = await handler(event as never, {} as never, () => undefined);
  if (result === undefined || typeof result === "string") {
    throw new Error("expected a structured APIGatewayProxyStructuredResultV2");
  }
  return result;
}

const eventMeta: Record<string, unknown> = {
  PK: "EVENT#evt-1", SK: "META", id: "evt-1", title: "NIL STAR · Season 1",
  status: "live", startsAt: "2026-07-13T00:00:00Z", endsAt: "2026-07-20T00:00:00Z",
};

const entryRows = [
  { PK: "EVENT#evt-1", SK: "ENTRY#ent-a", id: "ent-a", eventId: "evt-1", athleteId: "ath-a", votes: 10 },
  { PK: "EVENT#evt-1", SK: "ENTRY#ent-b", id: "ent-b", eventId: "evt-1", athleteId: "ath-b", votes: 20 },
  { PK: "EVENT#evt-1", SK: "ENTRY#ent-c", id: "ent-c", eventId: "evt-1", athleteId: "ath-c", votes: 30 },
];

const profileRows = [
  { PK: "ATHLETE#ath-a", SK: "META", id: "ath-a", name: "Athlete A", school: "Duke", sport: "Lacrosse", bio: "Bio A" },
  { PK: "ATHLETE#ath-b", SK: "META", id: "ath-b", name: "Athlete B", school: "UNC", sport: "Basketball", bio: "Bio B" },
  { PK: "ATHLETE#ath-c", SK: "META", id: "ath-c", name: "Athlete C", school: "UCLA", sport: "Gymnastics", bio: "Bio C" },
];

function mockTable(meta: Record<string, unknown> | null = eventMeta) {
  sendMock.mockImplementation((command: { input: Record<string, unknown> }) => {
    const input = command.input;
    if (input["RequestItems"]) return Promise.resolve({ Responses: { [TABLE]: profileRows } });
    if (input["Key"]) return Promise.resolve(meta ? { Item: meta } : {});
    return Promise.resolve({ Items: entryRows });
  });
}

describe("GET /v1/events/{eventId} handler", () => {
  beforeEach(() => {
    sendMock.mockReset();
    process.env.TABLE_NAME = TABLE;
    delete process.env.ORIGIN_VERIFY_SECRET;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.ORIGIN_VERIFY_SECRET;
    vi.restoreAllMocks();
  });

  it("returns 404 NOT_FOUND for an unknown event", async () => {
    mockTable(null);
    const res = await invoke({ pathParameters: { eventId: "evt-ghost" } });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body ?? "")).toEqual({ error: "NOT_FOUND" });
  });

  it("joins entries with athlete profiles and rotates by the UTC minute", async () => {
    // minute 1, 3 entries → offset 1: b, c, a.
    vi.setSystemTime(new Date("2026-07-17T10:01:00Z"));
    mockTable();

    const res = await invoke({ pathParameters: { eventId: "evt-1" } });

    expect(res.statusCode).toBe(200);
    expect(res.headers?.["cache-control"]).toBe("public, max-age=30");
    const body = JSON.parse(res.body ?? "");
    expect(body.event).toMatchObject({ id: "evt-1", status: "live" });
    expect(body.event.PK).toBeUndefined();
    expect(body.entries.map((e: { id: string }) => e.id)).toEqual(["ent-b", "ent-c", "ent-a"]);
    expect(body.entries[2]).toMatchObject({
      id: "ent-a",
      athleteId: "ath-a",
      name: "Athlete A",
      school: "Duke",
      sport: "Lacrosse",
      bio: "Bio A",
      votes: 10,
    });
    expect(body.recap).toBeUndefined();
  });

  it("keeps stored order at minute 0 and includes the frozen recap when stored", async () => {
    vi.setSystemTime(new Date("2026-07-17T10:00:00Z"));
    const recap = {
      championEntryId: "ent-b",
      leaderboard: [{ entryId: "ent-b", rank: 1, votes: 20 }],
      totals: { votes: 60, entries: 3, daysLive: 7 },
    };
    mockTable({ ...eventMeta, status: "ended", recap });

    const res = await invoke({ pathParameters: { eventId: "evt-1" } });

    const body = JSON.parse(res.body ?? "");
    expect(body.entries.map((e: { id: string }) => e.id)).toEqual(["ent-a", "ent-b", "ent-c"]);
    expect(body.recap).toEqual(recap);
  });
});
