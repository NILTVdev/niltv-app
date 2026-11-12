import { describe, expect, it } from "vitest";
import { REFRESH_MARGIN_MS, after401, cognitoCode, refreshFailure, tokenStep } from "./session";

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
