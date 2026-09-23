import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sendMock = vi.hoisted(() => vi.fn());

vi.mock("../lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/db")>();
  return {
    ...actual,
    getDocClient: () => ({ send: sendMock }),
  };
});

import { handler } from "./channels";

const TABLE = "niltv-test";

async function invoke(event: Record<string, unknown> = {}) {
  const result = await handler(event as never, {} as never, () => undefined);
  if (result === undefined || typeof result === "string") {
    throw new Error("expected a structured APIGatewayProxyStructuredResultV2");
  }
  return result;
}

const channelItem = (id: string, name: string) => ({
  PK: `CHANNEL#${id}`,
  SK: "META",
  id,
  name,
  kind: id.replace("ch-", ""),
});

const trueblue = channelItem("ch-trueblue", "TrueBlue TV");
const niltv = channelItem("ch-niltv", "NIL TV");
const esports = channelItem("ch-esports", "NILTV Esports");

type Input = Record<string, unknown>;
/** One page of a GSI1 COUNT query, as DynamoDB returns it. */
type CountPage = { Count: number; LastEvaluatedKey?: Record<string, unknown> };

/**
 * Dispatch like DynamoDB would: Get → CONFIG, BatchGet → the channel items,
 * Query on GSI1 with Select COUNT → that channel's page sequence (a channel
 * not in `counts` counts 0). `config` undefined = no CONFIG item at all.
 */
function mockTable(opts: {
  config?: Record<string, unknown>;
  batch: Record<string, unknown>[];
  counts?: Record<string, CountPage[]>;
}) {
  const pending = new Map(Object.entries(opts.counts ?? {}).map(([id, pages]) => [id, [...pages]]));
  sendMock.mockImplementation((command: { input: Input }) => {
    const input = command.input;
    if (input["RequestItems"]) return Promise.resolve({ Responses: { [TABLE]: opts.batch } });
    if (input["Key"]) return Promise.resolve(opts.config ? { Item: opts.config } : {});
    if (input["IndexName"] === "GSI1" && input["Select"] === "COUNT") {
      const pk = (input["ExpressionAttributeValues"] as Record<string, string>)[":pk"] ?? "";
      const page = pending.get(pk.replace("CHANNEL#", ""))?.shift();
      return Promise.resolve(page ?? { Count: 0 });
    }
    return Promise.reject(new Error(`unexpected command ${JSON.stringify(input)}`));
  });
}

/** The inputs of every COUNT query issued, in call order. */
function countQueries(): Input[] {
  return sendMock.mock.calls
    .map(([command]) => (command as { input: Input }).input)
    .filter((input) => input["IndexName"] === "GSI1");
}

const partitionOf = (input: Input) => (input["ExpressionAttributeValues"] as Record<string, string>)[":pk"];

describe("GET /v1/channels handler", () => {
  beforeEach(() => {
    sendMock.mockReset();
    process.env.TABLE_NAME = TABLE;
    delete process.env.ORIGIN_VERIFY_SECRET;
  });

  afterEach(() => {
    delete process.env.ORIGIN_VERIFY_SECRET;
    vi.restoreAllMocks();
  });

  it("falls back to the launch channels when CONFIG has no channelIds", async () => {
    mockTable({
      batch: [niltv, trueblue],
      counts: { "ch-trueblue": [{ Count: 273 }], "ch-niltv": [{ Count: 12 }] },
    });

    const res = await invoke();

    expect(res.statusCode).toBe(200);
    expect(res.headers?.["cache-control"]).toBe("public, max-age=300");

    const batch = (sendMock.mock.calls[1]?.[0] as { input: Input }).input;
    expect((batch["RequestItems"] as Record<string, { Keys: unknown[] }>)[TABLE]?.Keys).toEqual([
      { PK: "CHANNEL#ch-trueblue", SK: "META" },
      { PK: "CHANNEL#ch-niltv", SK: "META" },
    ]);

    // Fallback order imposed even though BatchGet answered shuffled.
    const body = JSON.parse(res.body ?? "");
    expect(body.channels.map((c: { id: string }) => c.id)).toEqual(["ch-trueblue", "ch-niltv"]);
    expect(body.channels[0]).toEqual({
      id: "ch-trueblue", name: "TrueBlue TV", kind: "trueblue", clipCount: 273,
    });
  });

  it("uses the CONFIG channelIds list and preserves its order", async () => {
    mockTable({ config: { channelIds: ["ch-esports", "ch-niltv"] }, batch: [niltv, esports] });

    const res = await invoke();

    const batch = (sendMock.mock.calls[1]?.[0] as { input: Input }).input;
    expect((batch["RequestItems"] as Record<string, { Keys: unknown[] }>)[TABLE]?.Keys).toEqual([
      { PK: "CHANNEL#ch-esports", SK: "META" },
      { PK: "CHANNEL#ch-niltv", SK: "META" },
    ]);
    expect(JSON.parse(res.body ?? "").channels.map((c: { id: string }) => c.id)).toEqual([
      "ch-esports", "ch-niltv",
    ]);
  });

  it("skips dangling channel ids instead of failing the list, and never counts them", async () => {
    mockTable({ config: { channelIds: ["ch-ghost", "ch-niltv"] }, batch: [niltv] });

    const res = await invoke();
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body ?? "").channels.map((c: { id: string }) => c.id)).toEqual(["ch-niltv"]);
    expect(countQueries().map(partitionOf)).toEqual(["CHANNEL#ch-niltv"]);
  });

  it("treats a malformed channelIds attribute as absent (fallback)", async () => {
    mockTable({ config: { channelIds: [1, 2, 3] }, batch: [trueblue, niltv] });

    const res = await invoke();
    expect(JSON.parse(res.body ?? "").channels.map((c: { id: string }) => c.id)).toEqual([
      "ch-trueblue", "ch-niltv",
    ]);
  });

  it("attaches clipCount from one GSI1 COUNT query per channel", async () => {
    mockTable({
      config: { channelIds: ["ch-esports", "ch-niltv", "ch-trueblue"] },
      batch: [trueblue, esports, niltv],
      counts: { "ch-niltv": [{ Count: 7 }], "ch-trueblue": [{ Count: 273 }] },
    });

    const res = await invoke();

    // An empty partition counts 0, not absent: the client treats absent as unknown.
    const body = JSON.parse(res.body ?? "");
    expect(body.channels.map((c: { id: string; clipCount: number }) => [c.id, c.clipCount])).toEqual([
      ["ch-esports", 0],
      ["ch-niltv", 7],
      ["ch-trueblue", 273],
    ]);

    const queries = countQueries();
    expect(queries).toHaveLength(3);
    expect(new Set(queries.map(partitionOf))).toEqual(
      new Set(["CHANNEL#ch-esports", "CHANNEL#ch-niltv", "CHANNEL#ch-trueblue"]),
    );
    for (const input of queries) {
      expect(input).toMatchObject({
        TableName: TABLE,
        IndexName: "GSI1",
        KeyConditionExpression: "GSI1PK = :pk",
        Select: "COUNT",
      });
      expect(input["Limit"]).toBeUndefined();
      expect(input["ExclusiveStartKey"]).toBeUndefined();
    }
  });

  it("sums a paginated COUNT across pages, chaining LastEvaluatedKey", async () => {
    const lastKey = {
      PK: "CONTENT#ig-4", SK: "META", GSI1PK: "CHANNEL#ch-niltv", GSI1SK: "2026-08-01T00:00:00Z",
    };
    mockTable({
      config: { channelIds: ["ch-niltv"] },
      batch: [niltv],
      counts: { "ch-niltv": [{ Count: 4, LastEvaluatedKey: lastKey }, { Count: 3 }] },
    });

    const res = await invoke();

    expect(JSON.parse(res.body ?? "").channels[0]).toMatchObject({ id: "ch-niltv", clipCount: 7 });
    const queries = countQueries();
    expect(queries).toHaveLength(2);
    expect(queries[0]?.["ExclusiveStartKey"]).toBeUndefined();
    expect(queries[1]?.["ExclusiveStartKey"]).toEqual(lastKey);
  });

  it("returns 403 FORBIDDEN when the origin-verify header is missing", async () => {
    process.env.ORIGIN_VERIFY_SECRET = "test-origin-secret";
    const res = await invoke({ headers: {} });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body ?? "")).toEqual({ error: "FORBIDDEN" });
    expect(sendMock).not.toHaveBeenCalled();
  });
});
