import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sendMock = vi.hoisted(() => vi.fn());

vi.mock("../lib/s3", () => ({
  getS3Client: () => ({ send: sendMock }),
}));

import { handler } from "./telemetry";

async function invoke(event: Record<string, unknown>) {
  const result = await handler(event as never, {} as never, () => undefined);
  if (result === undefined || typeof result === "string") {
    throw new Error("expected a structured APIGatewayProxyStructuredResultV2");
  }
  return result;
}

const bodyEvent = (body: unknown) => ({
  body: typeof body === "string" ? body : JSON.stringify(body),
});

const validEvents = [
  { type: "screen_view", ts: "2026-07-21T12:00:00Z", props: { screen: "home" } },
  { type: "video_start", ts: "2026-07-21T12:00:05Z", props: { contentId: "c-1" } },
];

describe("POST /v1/telemetry handler", () => {
  beforeEach(() => {
    sendMock.mockReset();
    process.env.ANALYTICS_BUCKET = "niltv-test-analytics";
    delete process.env.ORIGIN_VERIFY_SECRET;
  });

  afterEach(() => {
    delete process.env.ORIGIN_VERIFY_SECRET;
    vi.restoreAllMocks();
  });

  it("returns 400 INVALID_BODY for a missing or non-JSON body", async () => {
    expect((await invoke({})).statusCode).toBe(400);
    const res = await invoke(bodyEvent("not-json{{"));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body ?? "")).toEqual({ error: "INVALID_BODY" });
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("returns 400 for a JSON body that fails the TelemetryBatchRequest schema", async () => {
    expect((await invoke(bodyEvent({}))).statusCode).toBe(400);
    expect((await invoke(bodyEvent({ events: [{ ts: "2026-07-21T12:00:00Z" }] }))).statusCode).toBe(400);
    expect((await invoke(bodyEvent({ events: [{ type: "x", ts: "yesterday" }] }))).statusCode).toBe(400);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("enriches events with receivedAt and writes one gzip NDJSON object per batch", async () => {
    sendMock.mockResolvedValueOnce({});

    const res = await invoke(bodyEvent({ events: validEvents }));

    expect(res.statusCode).toBe(202);
    expect(JSON.parse(res.body ?? "")).toEqual({ status: "ok" });
    expect(res.headers?.["cache-control"]).toBeUndefined();

    const input = (sendMock.mock.calls[0]?.[0] as { input: Record<string, unknown> }).input;
    expect(input["Bucket"]).toBe("niltv-test-analytics");
    expect(input["Key"]).toMatch(/^telemetry\/\d{4}\/\d{2}\/\d{2}\/[0-9a-f-]{36}\.ndjson\.gz$/);
    expect(input["ContentEncoding"]).toBe("gzip");

    const lines = gunzipSync(input["Body"] as Buffer)
      .toString("utf8")
      .trim()
      .split("\n");
    expect(lines).toHaveLength(2);
    const parsed = JSON.parse(lines[0] ?? "");
    expect(parsed).toMatchObject({
      type: "screen_view",
      ts: "2026-07-21T12:00:00Z",
      props: { screen: "home" },
    });
    expect(typeof parsed.receivedAt).toBe("string");
    expect(Number.isNaN(Date.parse(parsed.receivedAt))).toBe(false);
  });

  it("accepts an empty batch with 202 and never touches S3", async () => {
    const res = await invoke(bodyEvent({ events: [] }));
    expect(res.statusCode).toBe(202);
    expect(JSON.parse(res.body ?? "")).toEqual({ status: "ok" });
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("still returns 202 when the S3 write fails (fire-and-forget)", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    sendMock.mockRejectedValueOnce(new Error("s3 down"));

    const res = await invoke(bodyEvent({ events: validEvents }));

    expect(res.statusCode).toBe(202);
    expect(errorSpy).toHaveBeenCalledOnce();
  });

  it("enforces origin lockdown like every public route", async () => {
    process.env.ORIGIN_VERIFY_SECRET = "s3cret";
    const res = await invoke(bodyEvent({ events: [] }));
    expect(res.statusCode).toBe(403);
  });
});
