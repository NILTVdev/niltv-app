import { describe, expect, it } from "vitest";
import { isTemporary, retryAfterMs, retryDelay, shouldRetryRead } from "./retry";

describe("isTemporary", () => {
  it("treats no connection, 5xx and 429 as temporary", () => {
    expect(isTemporary({ status: 0 })).toBe(true);
    expect(isTemporary({ status: 503 })).toBe(true);
    expect(isTemporary({ status: 429 })).toBe(true);
    expect(isTemporary(new Error("boom"))).toBe(true);
  });

  it("treats other 4xx as final", () => {
    for (const status of [400, 401, 403, 404, 409]) expect(isTemporary({ status })).toBe(false);
  });
});

describe("shouldRetryRead", () => {
  it("retries a 429 up to three times", () => {
    expect(shouldRetryRead(0, { status: 429 })).toBe(true);
    expect(shouldRetryRead(2, { status: 429 })).toBe(true);
    expect(shouldRetryRead(3, { status: 429 })).toBe(false);
  });

  it("never retries a 401 or 403", () => {
    expect(shouldRetryRead(0, { status: 401 })).toBe(false);
    expect(shouldRetryRead(0, { status: 403 })).toBe(false);
  });
});

describe("retryDelay", () => {
  it("backs off and caps at 30 seconds", () => {
    expect(retryDelay(1, { status: 0 })).toBe(1000);
    expect(retryDelay(2, { status: 500 })).toBe(2000);
    expect(retryDelay(3, { status: 500 })).toBe(4000);
    expect(retryDelay(20, { status: 500 })).toBe(30_000);
  });

  it("waits longer after a 429, and at least what the server asked", () => {
    expect(retryDelay(1, { status: 429 })).toBe(2000);
    expect(retryDelay(1, { status: 429, retryAfterSec: 10 })).toBe(10_000);
    expect(retryDelay(1, { status: 429, retryAfterSec: 120 })).toBe(30_000);
  });
});

describe("retryAfterMs", () => {
  it("reads seconds and HTTP dates", () => {
    expect(retryAfterMs("5")).toBe(5000);
    const now = Date.parse("2026-11-12T12:00:00Z");
    expect(retryAfterMs("Thu, 12 Nov 2026 12:00:20 GMT", now)).toBe(20_000);
    expect(retryAfterMs("Thu, 12 Nov 2026 11:00:00 GMT", now)).toBe(0);
  });

  it("ignores a missing or unreadable header", () => {
    expect(retryAfterMs(null)).toBeUndefined();
    expect(retryAfterMs("soon")).toBeUndefined();
  });
});
