import { describe, expect, it } from "vitest";
import { rateLimitWaitMs } from "./ratelimit";

describe("rateLimitWaitMs", () => {
  it("waits out a short limit", () => {
    expect(rateLimitWaitMs({ status: 429, retryAfterSec: 12 })).toBe(12_500);
    expect(rateLimitWaitMs({ status: 429, retryAfterSec: 0 })).toBe(1_500);
    expect(rateLimitWaitMs({ status: 429 })).toBe(30_500);
  });

  it("leaves long limits and other errors alone", () => {
    expect(rateLimitWaitMs({ status: 429, retryAfterSec: 3_000 })).toBeUndefined();
    expect(rateLimitWaitMs({ status: 400 })).toBeUndefined();
    expect(rateLimitWaitMs(new Error("x"))).toBeUndefined();
    expect(rateLimitWaitMs(null)).toBeUndefined();
  });
});
