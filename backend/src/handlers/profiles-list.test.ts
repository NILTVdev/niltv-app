import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sendMock = vi.hoisted(() => vi.fn());

vi.mock("../lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/db")>();
  return {
    ...actual,
    getDocClient: () => ({ send: sendMock }),
  };
});

import { handler } from "./profiles-list";

async function invoke(event: Record<string, unknown> = {}) {
  const result = await handler(event as never, {} as never, () => undefined);
  if (result === undefined || typeof result === "string") {
    throw new Error("expected a structured APIGatewayProxyStructuredResultV2");
  }
  return result;
}

const profileRow = (id: string, name: string, statuses: string[], ambassadorRank?: number) => ({
  PK: `ATHLETE#${id}`,
  SK: "META",
  GSI1PK: "PROFILES#ALL",
  GSI1SK: ambassadorRank !== undefined ? String(ambassadorRank).padStart(2, "0") : name,
  id,
  name,
  school: "Duke",
  sport: "Lacrosse",
  statuses,
  ...(ambassadorRank !== undefined ? { ambassadorRank } : {}),
});

// Stored GSI order: rank-first ("01" < "02"), then names alphabetically.
const storedRows = [
  profileRow("ath-maya", "Maya Robinson", ["athlete", "ambassador"], 1),
  profileRow("ath-camila", "Camila Garza", ["athlete", "ambassador"], 2),
  profileRow("ath-isaiah", "Isaiah Carter", ["athlete"]),
  profileRow("ath-marcus", "Marcus Lee", ["athlete"]),
];

describe("GET /v1/profiles handler", () => {
  beforeEach(() => {
    sendMock.mockReset();
    process.env.TABLE_NAME = "niltv-test";
    delete process.env.ORIGIN_VERIFY_SECRET;
  });

  afterEach(() => {
    delete process.env.ORIGIN_VERIFY_SECRET;
    vi.restoreAllMocks();
  });

  it("returns every profile as chips in stored order without a filter", async () => {
    sendMock.mockResolvedValueOnce({ Items: storedRows });

    const res = await invoke({});

    expect(res.statusCode).toBe(200);
    expect(res.headers?.["cache-control"]).toBe("public, max-age=300");

    const query = (sendMock.mock.calls[0]?.[0] as { input: Record<string, unknown> }).input;
    expect(query).toMatchObject({
      IndexName: "GSI1",
      ExpressionAttributeValues: { ":pk": "PROFILES#ALL" },
    });

    const body = JSON.parse(res.body ?? "");
    expect(body.profiles.map((p: { id: string }) => p.id)).toEqual([
      "ath-maya", "ath-camila", "ath-isaiah", "ath-marcus",
    ]);
    expect(body.profiles[0]).toEqual({
      id: "ath-maya",
      name: "Maya Robinson",
      school: "Duke",
      sport: "Lacrosse",
      isAmbassador: true,
      ambassadorRank: 1,
    });
    expect(body.profiles[2].isAmbassador).toBe(false);
  });

  it("filter=ambassador keeps only ambassador-status rows in rank order", async () => {
    // Feed rows out of rank order to prove the filter re-sorts.
    sendMock.mockResolvedValueOnce({ Items: [...storedRows].reverse() });

    const res = await invoke({ queryStringParameters: { filter: "ambassador" } });

    const body = JSON.parse(res.body ?? "");
    expect(body.profiles.map((p: { id: string }) => p.id)).toEqual(["ath-maya", "ath-camila"]);
    expect(body.profiles.every((p: { isAmbassador: boolean }) => p.isAmbassador)).toBe(true);
  });

  it("returns 400 INVALID_PARAM for an unsupported filter", async () => {
    const res = await invoke({ queryStringParameters: { filter: "verified" } });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body ?? "")).toMatchObject({ error: "INVALID_PARAM" });
    expect(sendMock).not.toHaveBeenCalled();
  });
});
