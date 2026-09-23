import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sendMock = vi.hoisted(() => vi.fn());

vi.mock("../lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/db")>();
  return {
    ...actual,
    getDocClient: () => ({ send: sendMock }),
  };
});

import { handler } from "./home";

const TABLE = "niltv-test";

async function invoke(event: Record<string, unknown> = {}) {
  const result = await handler(event as never, {} as never, () => undefined);
  if (result === undefined || typeof result === "string") {
    throw new Error("expected a structured APIGatewayProxyStructuredResultV2");
  }
  return result;
}

/* ── stored items (raw table shapes, per scripts/seed.ts) ─────────────────── */

const configItem = { PK: "CONFIG#app", SK: "META", activeEventId: "evt-live" };

const eventItems = [
  {
    PK: "EVENT#evt-live", SK: "META", id: "evt-live", title: "NIL STAR · Season 1",
    status: "live", startsAt: "2026-07-13T00:00:00Z", endsAt: "2026-07-20T00:00:00Z",
  },
  {
    PK: "EVENT#evt-done", SK: "META", id: "evt-done", title: "Preseason",
    status: "ended", startsAt: "2026-05-01T00:00:00Z", endsAt: "2026-05-08T00:00:00Z",
  },
];

const profileItems = [
  {
    PK: "ATHLETE#ath-camila", SK: "META", id: "ath-camila", name: "Camila Garza",
    school: "Duke", sport: "Lacrosse", statuses: ["athlete", "ambassador"], ambassadorRank: 2,
  },
  {
    PK: "ATHLETE#ath-maya", SK: "META", id: "ath-maya", name: "Maya Robinson",
    school: "UCLA", sport: "Gymnastics", statuses: ["athlete", "ambassador"], ambassadorRank: 1,
  },
  {
    PK: "ATHLETE#ath-marcus", SK: "META", id: "ath-marcus", name: "Marcus Lee",
    school: "Texas", sport: "Track", statuses: ["athlete"],
  },
];

const niltvClip = {
  PK: "CONTENT#c-1", SK: "META", id: "c-1", title: "Camila's audition drops",
  channelId: "ch-niltv", athleteId: "ath-camila", duration: 192, publishedAt: "2026-07-13T12:00:00Z",
};
const nilstarClip = {
  PK: "CONTENT#c-2", SK: "META", id: "c-2", title: "Mat work Monday",
  channelId: "ch-nilstar", athleteId: "ath-marcus", duration: 224, publishedAt: "2026-07-06T12:00:00Z",
};

const batchResponses = [
  { PK: "CHANNEL#ch-niltv", SK: "META", id: "ch-niltv", name: "NIL TV", kind: "niltv" },
  { PK: "CHANNEL#ch-nilstar", SK: "META", id: "ch-nilstar", name: "NIL Star", kind: "campus" },
  { PK: "CHANNEL#ch-truebluetv", SK: "META", id: "ch-truebluetv", name: "TrueBlue TV", kind: "campus" },
  { PK: "CHANNEL#ch-dorecitytv", SK: "META", id: "ch-dorecitytv", name: "Dore City TV", kind: "campus" },
  { PK: "CHANNEL#ch-chapelhilltv", SK: "META", id: "ch-chapelhilltv", name: "Chapel Hill TV", kind: "campus" },
  { PK: "CHANNEL#ch-starkvilletv", SK: "META", id: "ch-starkvilletv", name: "Starkville TV", kind: "campus" },
  ...profileItems,
];

/** Dispatch like DynamoDB would: Get → config, Query → by GSI1 partition, BatchGet → lookups. */
function mockTable() {
  sendMock.mockImplementation((command: { input: Record<string, unknown> }) => {
    const input = command.input;
    if (input["RequestItems"]) return Promise.resolve({ Responses: { [TABLE]: batchResponses } });
    if (input["Key"]) return Promise.resolve({ Item: configItem });
    const pk = (input["ExpressionAttributeValues"] as Record<string, string>)[":pk"];
    if (pk === "EVENTS#ALL") return Promise.resolve({ Items: eventItems });
    if (pk === "PROFILES#ALL") return Promise.resolve({ Items: profileItems });
    if (pk === "CHANNEL#ch-niltv") return Promise.resolve({ Items: [niltvClip] });
    if (pk === "CHANNEL#ch-nilstar") return Promise.resolve({ Items: [nilstarClip] });
    return Promise.resolve({ Items: [] });
  });
}

describe("GET /v1/home handler", () => {
  beforeEach(() => {
    sendMock.mockReset();
    process.env.TABLE_NAME = TABLE;
    delete process.env.ORIGIN_VERIFY_SECRET;
  });

  afterEach(() => {
    delete process.env.ORIGIN_VERIFY_SECRET;
    vi.restoreAllMocks();
  });

  it("composes hero + the ambassadors and per-channel rails from the parallel reads", async () => {
    mockTable();

    const res = await invoke();

    expect(res.statusCode).toBe(200);
    expect(res.headers?.["cache-control"]).toBe("public, max-age=60");
    const body = JSON.parse(res.body ?? "");

    // Hero: the active event is live.
    expect(body.hero).toMatchObject({ state: "live", event: { id: "evt-live" } });

    // Rails in order: ambassadors, featured, NIL Star, then the channel rails
    // with TrueBlue TV first.
    expect(body.rails.map((r: { key: string }) => r.key)).toEqual([
      "ambassadors", "featured", "nilstar", "trueblue", "dorecity", "chapelhill", "starkville",
    ]);
    expect(body.rails.map((r: { title: string }) => r.title)).toEqual([
      "Featured Ambassadors", "Featured", "NIL Star", "TrueBlue TV", "Dore City TV", "Chapel Hill TV", "Starkville TV",
    ]);

    // Ambassadors: rank order, plain athletes excluded, flag set.
    const [ambassadors, featured, nilstar, ...emptyRails] = body.rails;
    expect(ambassadors.kind).toBe("athletes");
    expect(ambassadors.items.map((a: { id: string }) => a.id)).toEqual(["ath-maya", "ath-camila"]);
    expect(ambassadors.items[0]).toMatchObject({ isAmbassador: true, ambassadorRank: 1 });

    // Content cards carry channel + creator attribution.
    expect(featured.kind).toBe("content");
    expect(featured.items).toHaveLength(1);
    expect(featured.items[0]).toMatchObject({
      id: "c-1",
      channelId: "ch-niltv",
      channelName: "NIL TV",
      creatorId: "ath-camila",
      creatorName: "Camila Garza",
      creatorIsAmbassador: true,
    });
    expect(featured.items[0].PK).toBeUndefined();
    expect(nilstar.items[0]).toMatchObject({
      channelName: "NIL Star",
      creatorName: "Marcus Lee",
      creatorIsAmbassador: false,
    });
    for (const rail of emptyRails) expect(rail.items).toEqual([]);
  });

  it("queries each channel rail newest-first with its cap", async () => {
    mockTable();
    await invoke();

    const railCalls = sendMock.mock.calls
      .map(([command]) => (command as { input: Record<string, unknown> }).input)
      .filter((input) => {
        const values = input["ExpressionAttributeValues"] as Record<string, string> | undefined;
        return typeof values?.[":pk"] === "string" && values[":pk"].startsWith("CHANNEL#");
      });
    expect(railCalls).toHaveLength(6);
    for (const input of railCalls) {
      expect(input["IndexName"]).toBe("GSI1");
      expect(input["ScanIndexForward"]).toBe(false);
    }
    const limits = Object.fromEntries(
      railCalls.map((input) => [
        (input["ExpressionAttributeValues"] as Record<string, string>)[":pk"],
        input["Limit"],
      ]),
    );
    expect(limits).toEqual({
      "CHANNEL#ch-niltv": 6,
      "CHANNEL#ch-nilstar": 8,
      "CHANNEL#ch-truebluetv": 8,
      "CHANNEL#ch-dorecitytv": 8,
      "CHANNEL#ch-chapelhilltv": 8,
      "CHANNEL#ch-starkvilletv": 8,
    });
  });

  it("falls back to a recap hero when the active event has ended", async () => {
    mockTable();
    sendMock.mockImplementationOnce(() =>
      Promise.resolve({ Item: { ...configItem, activeEventId: "evt-done" } }),
    );

    // The Get is the first read issued; re-mock the rest via the base impl.
    const res = await invoke();
    const body = JSON.parse(res.body ?? "");
    expect(body.hero).toMatchObject({ state: "recap", event: { id: "evt-done" } });
  });

  it("returns 403 FORBIDDEN when the origin-verify header is missing", async () => {
    process.env.ORIGIN_VERIFY_SECRET = "test-origin-secret";
    const res = await invoke({ headers: {} });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body ?? "")).toEqual({ error: "FORBIDDEN" });
    expect(sendMock).not.toHaveBeenCalled();
  });
});
