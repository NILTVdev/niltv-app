import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sendMock = vi.hoisted(() => vi.fn());

vi.mock("../lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/db")>();
  return {
    ...actual,
    getDocClient: () => ({ send: sendMock }),
  };
});

import { handler } from "./profile";

async function invoke(event: Record<string, unknown>) {
  const result = await handler(event as never, {} as never, () => undefined);
  if (result === undefined || typeof result === "string") {
    throw new Error("expected a structured APIGatewayProxyStructuredResultV2");
  }
  return result;
}

const profileEvent = (athleteId = "ath-camila") => ({ pathParameters: { athleteId } });

const profileItem = {
  PK: "ATHLETE#ath-camila",
  SK: "META",
  GSI1PK: "PROFILES#ALL",
  GSI1SK: "02",
  id: "ath-camila",
  name: "Camila Garza",
  handle: "@camilagarza",
  school: "Duke",
  sport: "Lacrosse",
  bio: "Two-time All-American.",
  statuses: ["athlete", "ambassador"],
  ambassadorRank: 2,
  followers: 184_000,
  totalViews: 2_300_000,
  socials: [{ platform: "instagram", url: "https://instagram.com/camilagarza" }],
  brands: ["Garmin"],
};

const contentRow = (id: string, publishedAt: string) => ({
  PK: `CONTENT#${id}`,
  SK: "META",
  GSI2PK: "ATHLETE#ath-camila",
  GSI2SK: publishedAt,
  id,
  title: `Clip ${id}`,
  channelId: "ch-niltv",
  athleteId: "ath-camila",
  publishedAt,
});

// Entry rows exactly as seeded: GSI1PK ATHLETE#{athleteId}, GSI1SK ENTRY#{eventId}.
const entryRow = (eventId: string, votes: number) => ({
  PK: `EVENT#${eventId}`,
  SK: "ENTRY#ent-camila",
  GSI1PK: "ATHLETE#ath-camila",
  GSI1SK: `ENTRY#${eventId}`,
  id: "ent-camila",
  eventId,
  athleteId: "ath-camila",
  votes,
});

const channelItem = { PK: "CHANNEL#ch-niltv", SK: "META", id: "ch-niltv", name: "NIL TV", kind: "niltv" };

describe("GET /v1/profiles/{athleteId} handler", () => {
  beforeEach(() => {
    sendMock.mockReset();
    process.env.TABLE_NAME = "niltv-test";
    delete process.env.ORIGIN_VERIFY_SECRET;
    delete process.env.PLAYBACK_BASE_URL;
  });

  afterEach(() => {
    delete process.env.ORIGIN_VERIFY_SECRET;
    delete process.env.PLAYBACK_BASE_URL;
    vi.restoreAllMocks();
  });

  it("returns 404 when the profile does not exist", async () => {
    sendMock
      .mockResolvedValueOnce({}) // profile Get
      .mockResolvedValueOnce({ Items: [] }) // GSI2 content
      .mockResolvedValueOnce({ Items: [] }); // GSI1 entries
    const res = await invoke(profileEvent("ath-ghost"));
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body ?? "")).toEqual({ error: "NOT_FOUND" });
  });

  it("joins profile, GSI2 content and summed entry votes into ProfileResponse", async () => {
    sendMock
      .mockResolvedValueOnce({ Item: profileItem })
      .mockResolvedValueOnce({
        Items: [contentRow("c-1", "2026-07-13T12:00:00Z"), contentRow("c-2", "2026-07-06T12:00:00Z")],
      })
      .mockResolvedValueOnce({
        Items: [entryRow("evt-nilstar-s1", 24_811), entryRow("evt-nilstar-preseason", 5_000)],
      })
      .mockResolvedValueOnce({ Responses: { "niltv-test": [channelItem] } });

    const res = await invoke(profileEvent());

    expect(res.statusCode).toBe(200);
    expect(res.headers?.["cache-control"]).toBe("public, max-age=60");

    // The content query runs on GSI2 newest-first, capped at 12.
    const contentQuery = (sendMock.mock.calls[1]?.[0] as { input: Record<string, unknown> }).input;
    expect(contentQuery).toMatchObject({
      IndexName: "GSI2",
      ScanIndexForward: false,
      Limit: 12,
      ExpressionAttributeValues: { ":pk": "ATHLETE#ath-camila" },
    });

    // The entries query isolates ENTRY# rows on GSI1 (follow mirrors share the partition).
    const entriesQuery = (sendMock.mock.calls[2]?.[0] as { input: Record<string, unknown> }).input;
    expect(entriesQuery).toMatchObject({
      IndexName: "GSI1",
      KeyConditionExpression: "GSI1PK = :pk AND begins_with(GSI1SK, :entry)",
      ExpressionAttributeValues: { ":pk": "ATHLETE#ath-camila", ":entry": "ENTRY#" },
    });

    const body = JSON.parse(res.body ?? "");
    expect(body).toMatchObject({
      id: "ath-camila",
      name: "Camila Garza",
      handle: "@camilagarza",
      statuses: ["athlete", "ambassador"],
      ambassadorRank: 2,
      stats: { followers: 184_000, views: 2_300_000, nilstarVotes: 29_811 },
      brands: ["Garmin"],
    });
    expect(body.content.map((c: { id: string }) => c.id)).toEqual(["c-1", "c-2"]);
    expect(body.content[0]).toMatchObject({
      channelName: "NIL TV",
      creatorId: "ath-camila",
      creatorName: "Camila Garza",
      creatorIsAmbassador: true,
    });
  });

  it("zeroes nilstarVotes when the athlete has no entry rows", async () => {
    sendMock
      .mockResolvedValueOnce({ Item: profileItem })
      .mockResolvedValueOnce({ Items: [] })
      .mockResolvedValueOnce({ Items: [] });

    const res = await invoke(profileEvent());
    const body = JSON.parse(res.body ?? "");
    expect(body.stats.nilstarVotes).toBe(0);
    expect(body.content).toEqual([]);
    // No channels to resolve → no BatchGet.
    expect(sendMock).toHaveBeenCalledTimes(3);
  });
});
