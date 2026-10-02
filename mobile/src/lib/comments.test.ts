import { COMMENT_ERROR_REJECTED, COMMENT_MAX_LENGTH } from "@niltv/types";
import { describe, expect, it } from "vitest";

import { canSubmitComment, commentAge, postErrorMessage } from "./comments";

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
  it("maps rate limiting and falls back generically", () => {
    expect(postErrorMessage({ status: 429, code: "X" })).toMatch(/too fast/);
    expect(postErrorMessage(new Error("boom"))).toMatch(/try again/);
  });
});
