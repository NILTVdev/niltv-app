import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sendMock = vi.hoisted(() => vi.fn());

vi.mock("../lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/db")>();
  return {
    ...actual,
    getDocClient: () => ({ send: sendMock }),
  };
});

import { decodeCursor, encodeCursor } from "../lib/shape";
import { handler } from "./content-list";

async function invoke(event: Record<string, unknown>) {
  const result = await handler(event as never, {} as never, () => undefined);
  if (result === undefined || typeof result === "string") {
    throw new Error("expected a structured APIGatewayProxyStructuredResultV2");
  }
  return result;
}

const listEvent = (queryStringParameters?: Record<string, string>) => ({
  ...(queryStringParameters ? { queryStringParameters } : {}),
});

const contentRow = (id: string, publishedAt: string) => ({
  PK: `CONTENT#${id}`,
  SK: "META",
  GSI1PK: "CHANNEL#ch-niltv",
  GSI1SK: publishedAt,
  id,
  title: `Clip ${id}`,
  channelId: "ch-niltv",
  athleteId: "ath-camila",
  provider: "hls",
  playbackUrl: "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8",
  duration: 120,
  publishedAt,
});

const channelItem = { PK: "CHANNEL#ch-niltv", SK: "META", id: "ch-niltv", name: "NIL TV", kind: "niltv" };
const profileItem = {
  PK: "ATHLETE#ath-camila",
  SK: "META",
  id: "ath-camila",
  name: "Camila Garza",
  school: "Duke",
  sport: "Lacrosse",
  statuses: ["athlete", "ambassador"],
};

describe("GET /v1/content handler", () => {
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

  it("returns 400 INVALID_PARAM when channelId is missing", async () => {
    const res = await invoke(listEvent());
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body ?? "")).toMatchObject({ error: "INVALID_PARAM" });
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("returns 400 when both channelId and athleteId are passed", async () => {
    const res = await invoke(listEvent({ channelId: "ch-niltv", athleteId: "ath-camila" }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body ?? "")).toMatchObject({ error: "INVALID_PARAM" });
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("pages a creator's clips via GSI2 and resolves channels from the rows", async () => {
    sendMock
      .mockResolvedValueOnce({ Items: [contentRow("c-1", "2026-07-13T12:00:00Z")] })
      .mockResolvedValueOnce({ Responses: { "niltv-test": [channelItem, profileItem] } });

    const res = await invoke(listEvent({ athleteId: "ath-camila" }));
    expect(res.statusCode).toBe(200);

    const query = (sendMock.mock.calls[0]?.[0] as { input: Record<string, unknown> }).input;
    expect(query).toMatchObject({
      IndexName: "GSI2",
      KeyConditionExpression: "GSI2PK = :pk",
      ScanIndexForward: false,
      ExpressionAttributeValues: { ":pk": "ATHLETE#ath-camila" },
    });

    // A creator's clips can span channels — the channel key must come from the
    // row, not from a channelId param (there is none on this path).
    const batch = (sendMock.mock.calls[1]?.[0] as { input: Record<string, unknown> }).input;
    const keys = (batch["RequestItems"] as Record<string, { Keys: unknown[] }>)["niltv-test"]!.Keys;
    expect(keys).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ PK: "CHANNEL#ch-niltv" }),
        expect.objectContaining({ PK: "ATHLETE#ath-camila" }),
      ]),
    );

    const body = JSON.parse(res.body ?? "");
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ channelName: "NIL TV", creatorName: "Camila Garza" });
  });

  it("returns 400 for a non-numeric or non-positive limit", async () => {
    expect((await invoke(listEvent({ channelId: "ch-niltv", limit: "abc" }))).statusCode).toBe(400);
    expect((await invoke(listEvent({ channelId: "ch-niltv", limit: "0" }))).statusCode).toBe(400);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("returns 400 for a malformed cursor", async () => {
    const res = await invoke(listEvent({ channelId: "ch-niltv", cursor: "not-a-cursor" }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body ?? "")).toMatchObject({ error: "INVALID_PARAM" });
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("queries GSI1 newest-first with the default limit and maps cards", async () => {
    sendMock
      .mockResolvedValueOnce({ Items: [contentRow("c-1", "2026-07-13T12:00:00Z")] })
      .mockResolvedValueOnce({ Responses: { "niltv-test": [channelItem, profileItem] } });

    const res = await invoke(listEvent({ channelId: "ch-niltv" }));

    expect(res.statusCode).toBe(200);
    expect(res.headers?.["cache-control"]).toBe("public, max-age=60");

    const query = (sendMock.mock.calls[0]?.[0] as { input: Record<string, unknown> }).input;
    expect(query).toMatchObject({
      IndexName: "GSI1",
      ScanIndexForward: false,
      Limit: 24,
      ExpressionAttributeValues: { ":pk": "CHANNEL#ch-niltv" },
    });
    expect(query["ExclusiveStartKey"]).toBeUndefined();

    const body = JSON.parse(res.body ?? "");
    expect(body.cursor).toBeUndefined();
    expect(body.items).toEqual([
      {
        id: "c-1",
        title: "Clip c-1",
        channelId: "ch-niltv",
        channelName: "NIL TV",
        creatorId: "ath-camila",
        creatorName: "Camila Garza",
        creatorIsAmbassador: true,
        duration: 120,
        publishedAt: "2026-07-13T12:00:00Z",
      },
    ]);
  });

  it("clamps limit to 48", async () => {
    sendMock.mockResolvedValueOnce({ Items: [] });
    await invoke(listEvent({ channelId: "ch-niltv", limit: "500" }));
    const query = (sendMock.mock.calls[0]?.[0] as { input: Record<string, unknown> }).input;
    expect(query["Limit"]).toBe(48);
  });

  it("emits a cursor for LastEvaluatedKey and resumes from it on the next page", async () => {
    const lastKey = {
      PK: "CONTENT#c-1",
      SK: "META",
      GSI1PK: "CHANNEL#ch-niltv",
      GSI1SK: "2026-07-13T12:00:00Z",
    };
    sendMock
      .mockResolvedValueOnce({ Items: [contentRow("c-1", "2026-07-13T12:00:00Z")], LastEvaluatedKey: lastKey })
      .mockResolvedValueOnce({ Responses: { "niltv-test": [channelItem, profileItem] } });

    const first = await invoke(listEvent({ channelId: "ch-niltv" }));
    const cursor = JSON.parse(first.body ?? "").cursor as string;
    expect(decodeCursor(cursor)).toEqual(lastKey);

    sendMock.mockClear();
    sendMock
      .mockResolvedValueOnce({ Items: [contentRow("c-2", "2026-07-10T12:00:00Z")] })
      .mockResolvedValueOnce({ Responses: { "niltv-test": [channelItem, profileItem] } });

    const second = await invoke(listEvent({ channelId: "ch-niltv", cursor }));
    expect(second.statusCode).toBe(200);
    const query = (sendMock.mock.calls[0]?.[0] as { input: Record<string, unknown> }).input;
    expect(query["ExclusiveStartKey"]).toEqual(lastKey);
    expect(JSON.parse(second.body ?? "").cursor).toBeUndefined();
  });

  it("returns an empty page without a BatchGet when the channel has no clips", async () => {
    sendMock.mockResolvedValueOnce({ Items: [] });
    const res = await invoke(listEvent({ channelId: "ch-ghost" }));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body ?? "")).toEqual({ items: [] });
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it("composes card thumbs from PLAYBACK_BASE_URL for pipeline rows", async () => {
    process.env.PLAYBACK_BASE_URL = "https://cdn.example.com";
    const row = {
      ...contentRow("c-1", "2026-07-13T12:00:00Z"),
      thumbPath: "/video/c-1/poster.0000000.jpg",
    };
    sendMock
      .mockResolvedValueOnce({ Items: [row] })
      .mockResolvedValueOnce({ Responses: { "niltv-test": [channelItem, profileItem] } });

    const res = await invoke(listEvent({ channelId: "ch-niltv" }));
    const body = JSON.parse(res.body ?? "");
    expect(body.items[0].thumbUrl).toBe("https://cdn.example.com/video/c-1/poster.0000000.jpg");
  });

  // Round-trip guard for the helper the whole pager hangs on.
  it("encodeCursor(decodeCursor) is stable", () => {
    const key = { PK: "CONTENT#c-9", SK: "META", GSI1PK: "CHANNEL#ch-x", GSI1SK: "2026-01-01T00:00:00Z" };
    expect(decodeCursor(encodeCursor(key))).toEqual(key);
  });
});
