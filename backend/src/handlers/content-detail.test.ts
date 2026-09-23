import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sendMock = vi.hoisted(() => vi.fn());

vi.mock("../lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/db")>();
  return {
    ...actual,
    getDocClient: () => ({ send: sendMock }),
  };
});

import { handler } from "./content-detail";

async function invoke(event: Record<string, unknown>) {
  const result = await handler(event as never, {} as never, () => undefined);
  if (result === undefined || typeof result === "string") {
    throw new Error("expected a structured APIGatewayProxyStructuredResultV2");
  }
  return result;
}

const detailEvent = (contentId = "c-1") => ({ pathParameters: { contentId } });

const publishedRow = (overrides: Record<string, unknown> = {}) => ({
  PK: "CONTENT#c-1",
  SK: "META",
  id: "c-1",
  title: "Clip c-1",
  description: "A clip",
  channelId: "ch-niltv",
  athleteId: "ath-camila",
  provider: "hls",
  likes: 12,
  duration: 120,
  publishedAt: "2026-07-13T12:00:00Z",
  ...overrides,
});

const relatedRow = (id: string, publishedAt: string) => ({
  PK: `CONTENT#${id}`,
  SK: "META",
  id,
  title: `Clip ${id}`,
  channelId: "ch-niltv",
  athleteId: "ath-camila",
  playbackUrl: "https://cdn.example.com/legacy.m3u8",
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
  ambassadorRank: 2,
};

/** Mocks the Get→Query(related)→BatchGet sequence for a happy-path read. */
function mockHappyPath(row: Record<string, unknown>, related: Record<string, unknown>[] = []) {
  sendMock
    .mockResolvedValueOnce({ Item: row })
    .mockResolvedValueOnce({ Items: related })
    .mockResolvedValueOnce({ Responses: { "niltv-test": [channelItem, profileItem] } });
}

describe("GET /v1/content/{contentId} handler", () => {
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

  it("returns 404 when the row does not exist", async () => {
    sendMock.mockResolvedValueOnce({});
    const res = await invoke(detailEvent());
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body ?? "")).toEqual({ error: "NOT_FOUND" });
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it("returns 404 for an unpublished row (publishedAt unset) — drafts never leak", async () => {
    sendMock.mockResolvedValueOnce({
      Item: publishedRow({ publishedAt: undefined, transcodeStatus: "processing" }),
    });
    const res = await invoke(detailEvent());
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body ?? "")).toEqual({ error: "NOT_FOUND" });
  });

  it("returns 404 PLAYBACK_UNAVAILABLE when no URL can be resolved", async () => {
    // Path-only row with no PLAYBACK_BASE_URL configured → not playable.
    sendMock.mockResolvedValueOnce({
      Item: publishedRow({ playbackPath: "/video/c-1/index.m3u8" }),
    });
    const res = await invoke(detailEvent());
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body ?? "")).toEqual({ error: "PLAYBACK_UNAVAILABLE" });
    expect(sendMock).toHaveBeenCalledTimes(1); // fails before the related query
  });

  it("composes playbackUrl/thumbUrl from PLAYBACK_BASE_URL + stored paths", async () => {
    process.env.PLAYBACK_BASE_URL = "https://d1nm1d2txb83wa.cloudfront.net";
    mockHappyPath(
      publishedRow({
        playbackPath: "/video/c-1/index.m3u8",
        thumbPath: "/video/c-1/poster.0000000.jpg",
        duration: undefined,
        durationSec: 98, // transcode-complete stamps durationSec
      }),
    );

    const res = await invoke(detailEvent());

    expect(res.statusCode).toBe(200);
    expect(res.headers?.["cache-control"]).toBe("public, max-age=60");
    const body = JSON.parse(res.body ?? "");
    expect(body.playbackUrl).toBe("https://d1nm1d2txb83wa.cloudfront.net/video/c-1/index.m3u8");
    expect(body.thumbUrl).toBe("https://d1nm1d2txb83wa.cloudfront.net/video/c-1/poster.0000000.jpg");
    expect(body.duration).toBe(98);
    expect(body.creator).toEqual({
      id: "ath-camila",
      name: "Camila Garza",
      school: "Duke",
      sport: "Lacrosse",
      isAmbassador: true,
      ambassadorRank: 2,
    });
  });

  it("passes a stored absolute playbackUrl through untouched", async () => {
    process.env.PLAYBACK_BASE_URL = "https://d1nm1d2txb83wa.cloudfront.net";
    mockHappyPath(
      publishedRow({ playbackUrl: "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8" }),
    );

    const res = await invoke(detailEvent());
    expect(JSON.parse(res.body ?? "").playbackUrl).toBe(
      "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8",
    );
  });

  it("related excludes the clip itself and caps at 6", async () => {
    const related = [
      relatedRow("c-1", "2026-07-13T12:00:00Z"), // self — must be dropped
      relatedRow("c-2", "2026-07-12T12:00:00Z"),
      relatedRow("c-3", "2026-07-11T12:00:00Z"),
      relatedRow("c-4", "2026-07-10T12:00:00Z"),
      relatedRow("c-5", "2026-07-09T12:00:00Z"),
      relatedRow("c-6", "2026-07-08T12:00:00Z"),
      relatedRow("c-7", "2026-07-07T12:00:00Z"),
    ];
    mockHappyPath(publishedRow({ playbackUrl: "https://cdn.example.com/c-1.m3u8" }), related);

    const res = await invoke(detailEvent());
    const body = JSON.parse(res.body ?? "");
    expect(body.related.map((c: { id: string }) => c.id)).toEqual([
      "c-2", "c-3", "c-4", "c-5", "c-6", "c-7",
    ]);

    // The related query asks for one extra so the self-exclusion keeps 6.
    const query = (sendMock.mock.calls[1]?.[0] as { input: Record<string, unknown> }).input;
    expect(query).toMatchObject({ IndexName: "GSI1", ScanIndexForward: false, Limit: 7 });
  });
});
