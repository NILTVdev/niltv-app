import { describe, expect, it } from "vitest";

import { inviteEmailBody, verificationEmailBody } from "./email-templates";

const count = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

// Cognito's hard limits: the placeholder exactly once, at most 20,000 characters.
const COGNITO_MAX = 20_000;
const LOGO_BASE = "https://cdn.example";

describe("Cognito email templates", () => {
  it("verification carries {####} once and no {username}", () => {
    const body = verificationEmailBody(LOGO_BASE);
    expect(count(body, "{####}")).toBe(1);
    expect(body).not.toContain("{username}");
    expect(body.length).toBeLessThan(COGNITO_MAX);
  });

  it("invitation carries {username} and {####} once each", () => {
    const body = inviteEmailBody(LOGO_BASE);
    expect(count(body, "{####}")).toBe(1);
    expect(count(body, "{username}")).toBe(1);
    expect(body.length).toBeLessThan(COGNITO_MAX);
  });

  it("composes the mark from the stage's CDN, or falls back to the wordmark", () => {
    expect(verificationEmailBody(LOGO_BASE)).toContain(
      `<img src="${LOGO_BASE}/video/brand/email/niltv-email@2x.png"`,
    );
    const plain = verificationEmailBody(undefined);
    expect(plain).not.toContain("<img");
    expect(plain).toContain("NIL TV");
  });

  it("uses the neutral email palette, not the site's blue-shifted greys", () => {
    for (const body of [verificationEmailBody(LOGO_BASE), inviteEmailBody(LOGO_BASE)]) {
      expect(body).not.toMatch(/#16161c|#2a2a33|#75757f/i);
      expect(body).toContain("#0a0a0a");
      expect(body).toContain("Barlow Condensed");
    }
  });
});
