import { describe, expect, it } from "vitest";
import { REFRESH_MARGIN_MS, after401, cognitoCode, parseClockDrift, refreshFailure, serverNow, tokenStep } from "./session";

const now = 1_800_000_000_000;
const min = 60_000;

describe("tokenStep", () => {
  it("uses a token with more than five minutes left", () => {
    expect(tokenStep({ idExpiresAt: now + 30 * min, hasRefreshToken: true, now })).toBe("use");
  });

  it("refreshes five minutes early", () => {
    expect(tokenStep({ idExpiresAt: now + REFRESH_MARGIN_MS - 1, hasRefreshToken: true, now })).toBe("refresh");
    expect(tokenStep({ idExpiresAt: now - 10 * min, hasRefreshToken: true, now })).toBe("refresh");
  });

  it("refreshes when forced, even with a fresh token", () => {
    expect(tokenStep({ idExpiresAt: now + 30 * min, hasRefreshToken: true, now, force: true })).toBe("refresh");
  });

  it("refreshes when only the refresh token is left", () => {
    expect(tokenStep({ idExpiresAt: null, hasRefreshToken: true, now })).toBe("refresh");
  });

  it("is signed out with no tokens, or an expired token and nothing to refresh it", () => {
    expect(tokenStep({ idExpiresAt: null, hasRefreshToken: false, now })).toBe("signedOut");
    expect(tokenStep({ idExpiresAt: now - 1, hasRefreshToken: false, now })).toBe("signedOut");
    expect(tokenStep({ idExpiresAt: now + 30 * min, hasRefreshToken: false, now, force: true })).toBe("signedOut");
  });

  it("keeps using a still-valid token when there is no refresh token", () => {
    expect(tokenStep({ idExpiresAt: now + min, hasRefreshToken: false, now })).toBe("use");
  });
});

describe("refreshFailure", () => {
  it("signs out only on NotAuthorizedException", () => {
    expect(refreshFailure({ code: "NotAuthorizedException", idExpiresAt: now + min, now })).toBe("signedOut");
    for (const code of ["NetworkError", "TooManyRequestsException", "InternalErrorException", undefined]) {
      expect(refreshFailure({ code, idExpiresAt: null, now })).not.toBe("signedOut");
    }
  });

  it("keeps the current token while it is valid", () => {
    expect(refreshFailure({ code: "NetworkError", idExpiresAt: now + min, now })).toBe("useStale");
  });

  it("reports the service unreachable when the token has lapsed", () => {
    expect(refreshFailure({ code: "NetworkError", idExpiresAt: now - min, now })).toBe("unavailable");
  });

  it("never reuses a token the API just refused", () => {
    expect(refreshFailure({ code: "NetworkError", idExpiresAt: now + min, now, force: true })).toBe("unavailable");
  });
});

describe("after401", () => {
  it("retries once, then signs out", () => {
    expect(after401(false)).toBe("refreshAndRetry");
    expect(after401(true)).toBe("signOut");
  });
});

describe("cognitoCode", () => {
  it("reads code, then name", () => {
    expect(cognitoCode({ code: "NotAuthorizedException", name: "Error" })).toBe("NotAuthorizedException");
    expect(cognitoCode({ name: "NetworkError" })).toBe("NetworkError");
    expect(cognitoCode(new TypeError("Failed to fetch"))).toBe("TypeError");
    expect(cognitoCode(null)).toBeUndefined();
    expect(cognitoCode("x")).toBeUndefined();
  });
});

describe("clock drift", () => {
  it("reads the stored drift, or none", () => {
    expect(parseClockDrift("3600")).toBe(3600);
    expect(parseClockDrift("-120")).toBe(-120);
    expect(parseClockDrift(null)).toBe(0);
    expect(parseClockDrift("junk")).toBe(0);
  });

  it("judges a token on the server's time when the device clock runs fast", () => {
    // Device clock is an hour ahead; the token has 30 minutes left on the server.
    const drift = 3600;
    const device = now + 60 * min;
    const idExpiresAt = now + 30 * min;
    expect(tokenStep({ idExpiresAt, hasRefreshToken: true, now: device })).toBe("refresh");
    expect(tokenStep({ idExpiresAt, hasRefreshToken: true, now: serverNow(drift, device) })).toBe("use");
    expect(refreshFailure({ code: "NetworkError", idExpiresAt, now: serverNow(drift, device) })).toBe("useStale");
  });

  it("refreshes an expired token when the device clock runs slow", () => {
    const drift = -3600;
    const device = now - 60 * min;
    const idExpiresAt = now - min;
    expect(tokenStep({ idExpiresAt, hasRefreshToken: true, now: serverNow(drift, device) })).toBe("refresh");
  });
});
