import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sendMock = vi.hoisted(() => vi.fn());

vi.mock("../lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/db")>();
  return {
    ...actual,
    getDocClient: () => ({ send: sendMock }),
  };
});

import { handler } from "./events-list";

async function invoke(event: Record<string, unknown> = {}) {
  const result = await handler(event as never, {} as never, () => undefined);
  if (result === undefined || typeof result === "string") {
    throw new Error("expected a structured APIGatewayProxyStructuredResultV2");
  }
  return result;
}

const event = (id: string, status: string, startsAt: string, endsAt: string) => ({
  PK: `EVENT#${id}`, SK: "META", GSI1PK: "EVENTS#ALL", GSI1SK: `${status}#${startsAt}`,
  id, title: `Event ${id}`, status, startsAt, endsAt,
});

describe("GET /v1/events handler", () => {
  beforeEach(() => {
    sendMock.mockReset();
    process.env.TABLE_NAME = "niltv-test";
    delete process.env.ORIGIN_VERIFY_SECRET;
  });

  afterEach(() => {
    delete process.env.ORIGIN_VERIFY_SECRET;
    vi.restoreAllMocks();
  });

  it("returns live → upcoming (soonest first) → ended (most recent first)", async () => {
    // GSI order is status-alphabetical; the handler must re-sort.
    sendMock.mockResolvedValueOnce({
      Items: [
        event("evt-old", "ended", "2026-04-10T00:00:00Z", "2026-04-17T00:00:00Z"),
        event("evt-recent", "ended", "2026-05-01T00:00:00Z", "2026-05-08T00:00:00Z"),
        event("evt-live", "live", "2026-07-13T00:00:00Z", "2026-07-20T00:00:00Z"),
        event("evt-later", "upcoming", "2026-10-01T00:00:00Z", "2026-10-15T00:00:00Z"),
        event("evt-soon", "upcoming", "2026-08-14T17:00:00Z", "2026-08-21T00:00:00Z"),
      ],
    });

    const res = await invoke();

    expect(res.statusCode).toBe(200);
    expect(res.headers?.["cache-control"]).toBe("public, max-age=60");
    const body = JSON.parse(res.body ?? "");
    expect(body.events.map((e: { id: string }) => e.id)).toEqual([
      "evt-live", "evt-soon", "evt-later", "evt-recent", "evt-old",
    ]);
    // Table/GSI keys never leak into the cards.
    expect(body.events[0].PK).toBeUndefined();
    expect(body.events[0].GSI1PK).toBeUndefined();
  });

  it("returns an empty list when no events exist", async () => {
    sendMock.mockResolvedValueOnce({ Items: [] });
    const res = await invoke();
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body ?? "")).toEqual({ events: [] });
  });
});
