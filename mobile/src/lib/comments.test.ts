import { COMMENT_ERROR_REJECTED, COMMENT_ERROR_TERMS_REQUIRED, COMMENT_MAX_LENGTH } from "@niltv/types";
import { describe, expect, it } from "vitest";

import { MILD_WORDS, THREAT_PHRASES } from "@niltv/types/comment-filter";

import {
  canSubmitComment,
  commentAge,
  guidelineLinks,
  isExplicitDraft,
  isTermsRequired,
  postErrorMessage,
} from "./comments";

describe("canSubmitComment", () => {
  it("rejects empty and whitespace-only drafts", () => {
    expect(canSubmitComment("")).toBe(false);
    expect(canSubmitComment("   \n")).toBe(false);
  });
  it("accepts up to the max after trimming", () => {
    expect(canSubmitComment("a".repeat(COMMENT_MAX_LENGTH))).toBe(true);
    expect(canSubmitComment(` ${"a".repeat(COMMENT_MAX_LENGTH)} `)).toBe(true);
    expect(canSubmitComment("a".repeat(COMMENT_MAX_LENGTH + 1))).toBe(false);
  });
});

describe("explicit drafts", () => {
  // Samples come from the shared word list, so this file holds no offensive text.
  it("blocks sending text the server would reject", () => {
    for (const phrase of THREAT_PHRASES) {
      expect(isExplicitDraft(phrase), phrase.length.toString()).toBe(true);
      expect(canSubmitComment(`nice one, ${phrase}`)).toBe(false);
    }
  });
  it("blocks it even when disguised with repeats", () => {
    const [first] = THREAT_PHRASES;
    expect(canSubmitComment(first!.replace(/o/g, "oooo"))).toBe(false);
  });
  it("does not block clean text, links, or mild swearing (the server holds those)", () => {
    expect(canSubmitComment("Great game!")).toBe(true);
    expect(canSubmitComment("see https://example.com")).toBe(true);
    const [mild] = [...MILD_WORDS];
    expect(canSubmitComment(`that was ${mild} great`)).toBe(true);
  });
});

describe("commentAge", () => {
  const now = Date.parse("2026-10-10T12:00:00Z");
  it("buckets by unit", () => {
    expect(commentAge("2026-10-10T11:59:30Z", now)).toBe("now");
    expect(commentAge("2026-10-10T11:55:00Z", now)).toBe("5m");
    expect(commentAge("2026-10-10T09:00:00Z", now)).toBe("3h");
    expect(commentAge("2026-10-08T12:00:00Z", now)).toBe("2d");
    expect(commentAge("2026-09-12T12:00:00Z", now)).toBe("4w");
  });
  it("tolerates future and invalid timestamps", () => {
    expect(commentAge("2026-10-10T12:05:00Z", now)).toBe("now");
    expect(commentAge("nope", now)).toBe("now");
  });
});

describe("postErrorMessage", () => {
  it("does not echo the server message on a filter rejection", () => {
    const e = { status: 422, code: COMMENT_ERROR_REJECTED, message: "matched rule: slur-list" };
    expect(postErrorMessage(e)).not.toContain("slur");
  });
  it("says comments are unavailable when the route is missing", () => {
    expect(postErrorMessage({ status: 404, code: "HTTP_ERROR" })).toMatch(/aren't available/);
  });
  it("maps rate limiting and falls back generically", () => {
    expect(postErrorMessage({ status: 429, code: "X" })).toMatch(/too fast/);
    expect(postErrorMessage(new Error("boom"))).toMatch(/try again/);
  });
});

describe("isTermsRequired", () => {
  it("matches only the terms 403", () => {
    expect(isTermsRequired({ status: 403, code: COMMENT_ERROR_TERMS_REQUIRED })).toBe(true);
    expect(isTermsRequired({ status: 403, code: "FORBIDDEN" })).toBe(false);
    expect(isTermsRequired(new Error("x"))).toBe(false);
    expect(isTermsRequired(null)).toBe(false);
  });
});

describe("guidelineLinks", () => {
  it("shows nothing until real values are configured", () => {
    expect(guidelineLinks({})).toEqual([]);
    expect(guidelineLinks({ guidelinesUrl: "", supportEmail: "  " })).toEqual([]);
  });
  it("builds an https guidelines link and a mailto contact link", () => {
    expect(guidelineLinks({ guidelinesUrl: "https://example.org/rules", supportEmail: "help@example.org" })).toEqual([
      { label: "Read the full guidelines", url: "https://example.org/rules" },
      { label: "Contact us", url: "mailto:help@example.org" },
    ]);
  });
  it("drops malformed or unsafe values instead of showing a broken or risky link", () => {
    expect(
      guidelineLinks({ guidelinesUrl: "http://example.org/rules", supportEmail: "not-an-email" }),
    ).toEqual([]);
    expect(guidelineLinks({ guidelinesUrl: "javascript:alert(1)" })).toEqual([]);
    expect(guidelineLinks({ guidelinesUrl: "https://a b.example" })).toEqual([]);
    expect(guidelineLinks({ supportEmail: "a@b.co?subject=x&bcc=y@z.com" })).toEqual([]);
    expect(guidelineLinks({ supportEmail: "a@b.co?subject=x.com" })).toEqual([]);
    expect(guidelineLinks({ supportEmail: "a%40b@c.org" })).toEqual([]);
  });
});
