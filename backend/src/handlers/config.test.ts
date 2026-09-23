import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sendMock = vi.hoisted(() => vi.fn());

vi.mock("../lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/db")>();
  return {
    ...actual,
    getDocClient: () => ({ send: sendMock }),
  };
});

import { handler } from "./config";

async function invoke(event: Record<string, unknown> = {}) {
  const result = await handler(event as never, {} as never, () => undefined);
  if (result === undefined || typeof result === "string") {
    throw new Error("expected a structured APIGatewayProxyStructuredResultV2");
  }
  return result;
}

describe("GET /v1/config handler", () => {
  beforeEach(() => {
    sendMock.mockReset();
    process.env.TABLE_NAME = "niltv-test";
    delete process.env.ORIGIN_VERIFY_SECRET;
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    delete process.env.ORIGIN_VERIFY_SECRET;
    vi.restoreAllMocks();
  });

  it("merges the stored CONFIG item over defaults — stored fields win", async () => {
    sendMock.mockResolvedValueOnce({
      Item: {
        PK: "CONFIG#app",
        SK: "META",
        activeEventId: "evt-nilstar-s1",
        flags: { liveSegment: true },
        minAppVersion: "1.2.3",
      },
    });

    const res = await invoke();

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body ?? "");
    // Stored fields win…
    expect(body.activeEventId).toBe("evt-nilstar-s1");
    expect(body.flags.liveSegment).toBe(true);
    expect(body.minAppVersion).toBe("1.2.3");
    // …and unset fields fall back to schema defaults.
    expect(body.flags.ambassadorDirectory).toBe(false);
    // Response envelope.
    expect(body.apiVersion).toBe("v1");
    expect(Number.isNaN(Date.parse(body.serverTime))).toBe(false);
    // Table keys never leak into the response.
    expect(body.PK).toBeUndefined();
    expect(body.SK).toBeUndefined();
    // Headers.
    expect(res.headers?.["content-type"]).toBe("application/json");
    expect(res.headers?.["cache-control"]).toBe("public, max-age=60");
  });

  it("returns pure defaults with 200 when DynamoDB fails (config never takes the app down)", async () => {
    sendMock.mockRejectedValueOnce(new Error("dynamo down"));

    const res = await invoke();

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body ?? "");
    expect(body.activeEventId).toBeNull();
    expect(body.flags).toEqual({ liveSegment: false, ambassadorDirectory: false });
    expect(body.minAppVersion).toBe("0.1.0");
    expect(body.apiVersion).toBe("v1");
    expect(res.headers?.["cache-control"]).toBe("public, max-age=60");
    expect(console.error).toHaveBeenCalled();
  });

  it("returns defaults with 200 when no CONFIG item exists yet", async () => {
    sendMock.mockResolvedValueOnce({});

    const res = await invoke();

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body ?? "");
    expect(body.activeEventId).toBeNull();
    expect(body.flags).toEqual({ liveSegment: false, ambassadorDirectory: false });
    expect(body.apiVersion).toBe("v1");
  });

  describe("origin lockdown (x-origin-verify)", () => {
    beforeEach(() => {
      process.env.ORIGIN_VERIFY_SECRET = "test-origin-secret";
    });

    it("returns 403 FORBIDDEN when the header is missing", async () => {
      const res = await invoke({ headers: {} });

      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body ?? "")).toEqual({ error: "FORBIDDEN" });
      expect(sendMock).not.toHaveBeenCalled();
    });

    it("returns 403 FORBIDDEN when the header does not match", async () => {
      const res = await invoke({ headers: { "x-origin-verify": "wrong-value" } });

      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body ?? "")).toEqual({ error: "FORBIDDEN" });
      expect(sendMock).not.toHaveBeenCalled();
    });

    it("serves config with 200 when the header matches", async () => {
      sendMock.mockResolvedValueOnce({});

      const res = await invoke({ headers: { "x-origin-verify": "test-origin-secret" } });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body ?? "").apiVersion).toBe("v1");
    });
  });
});
