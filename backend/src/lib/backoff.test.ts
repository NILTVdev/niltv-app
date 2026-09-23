import { describe, expect, it } from "vitest";
import { backoffDelayMs, VOTE_TRANSACTION_ATTEMPTS } from "./db";

describe("backoffDelayMs", () => {
  it("grows exponentially in its ceiling", () => {
    // random() pinned to 1 exposes the ceiling for each attempt.
    const one = () => 1;
    expect(backoffDelayMs(0, 25, 800, one)).toBe(25);
    expect(backoffDelayMs(1, 25, 800, one)).toBe(50);
    expect(backoffDelayMs(2, 25, 800, one)).toBe(100);
    expect(backoffDelayMs(3, 25, 800, one)).toBe(200);
  });

  it("clamps at the cap", () => {
    const one = () => 1;
    expect(backoffDelayMs(10, 25, 800, one)).toBe(800);
    expect(backoffDelayMs(20, 25, 800, one)).toBe(800);
  });

  it("uses FULL jitter — any value in [0, ceiling)", () => {
    // The point of full jitter: two contenders on the same attempt must be
    // able to land far apart. Fixed-delay-plus-noise re-collides them, which
    // is what produced a 280 ms failure cluster under load.
    expect(backoffDelayMs(3, 25, 800, () => 0)).toBe(0);
    expect(backoffDelayMs(3, 25, 800, () => 0.5)).toBe(100);
    expect(backoffDelayMs(3, 25, 800, () => 1)).toBe(200);
  });

  it("never returns a negative delay", () => {
    for (let a = 0; a < 8; a++) {
      expect(backoffDelayMs(a, 25, 800, () => 0)).toBeGreaterThanOrEqual(0);
    }
  });

  it("keeps the whole retry budget inside the API timeout", () => {
    const one = () => 1;
    let worst = 0;
    for (let a = 0; a < VOTE_TRANSACTION_ATTEMPTS - 1; a++) worst += backoffDelayMs(a, 25, 800, one);
    expect(worst).toBeLessThan(3000);
    expect(VOTE_TRANSACTION_ATTEMPTS).toBeGreaterThan(2);
  });
});
