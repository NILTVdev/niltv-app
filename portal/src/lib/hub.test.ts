import { type Ask, type ClaimStatus, MAX_SUBMISSION_BYTES, SUBMISSION_PART_BYTES } from "@niltv/types";
import { describe, expect, it } from "vitest";
import { formatBytes, hubCount, insertAt, splitAsks } from "./hub";
import { partRange, partsToSend, retryDelay } from "./upload";

const AT = "2026-11-05T12:00:00.000Z";

const ask = (over: Partial<Ask>): Ask => ({
  id: "a",
  title: "Test",
  format: "short",
  description: "",
  audience: { type: "everyone" },
  images: {},
  audienceLabel: "Every athlete",
  requiresApproval: false,
  status: "open",
  createdByName: "Staff",
  createdAt: AT,
  ...over,
});

const mine = (status: ClaimStatus) => ({ myClaim: { status, at: AT, note: "", reviewNote: "", files: [] } });
const claim = (status: ClaimStatus) => ({
  status,
  at: AT,
  note: "",
  reviewNote: "",
  files: [],
  person: { sub: "s", name: "S", role: "athlete" as const },
});

describe("hubCount", () => {
  it("counts only work sent back for athletes", () => {
    expect(hubCount([ask(mine("changes")), ask(mine("claimed")), ask({})], false)).toBe(1);
  });

  it("counts requests and submissions for staff", () => {
    const claims = [claim("requested"), claim("submitted"), claim("claimed"), claim("delivered")];
    expect(hubCount([ask({ claims })], true)).toBe(2);
  });
});

describe("splitAsks", () => {
  it("sorts asks into the three tabs", () => {
    const out = splitAsks([
      ask({ id: "open" }),
      ask({ id: "working", ...mine("claimed") }),
      ask({ id: "no", ...mine("declined") }),
      ask({ id: "done", ...mine("delivered") }),
    ]);
    expect(out.open.map((a) => a.id)).toEqual(["open"]);
    expect(out.mine.map((a) => a.id)).toEqual(["working", "no"]);
    expect(out.done.map((a) => a.id)).toEqual(["done"]);
  });
});

describe("upload parts", () => {
  it("sends every part of a new file", () => {
    expect(partsToSend(SUBMISSION_PART_BYTES * 2 + 1, [])).toEqual([1, 2, 3]);
  });

  it("skips what already arrived", () => {
    expect(partsToSend(SUBMISSION_PART_BYTES * 2 + 1, [1, 3])).toEqual([2]);
  });

  it("covers the whole file with no gaps", () => {
    const size = SUBMISSION_PART_BYTES + 5;
    expect(partRange(size, 1)).toEqual({ start: 0, end: SUBMISSION_PART_BYTES });
    expect(partRange(size, 2)).toEqual({ start: SUBMISSION_PART_BYTES, end: size });
  });

  it("handles a full 2 GB file", () => {
    expect(partsToSend(MAX_SUBMISSION_BYTES, [])).toHaveLength(128);
    expect(partRange(MAX_SUBMISSION_BYTES, 128).end).toBe(MAX_SUBMISSION_BYTES);
  });

  it("backs off between attempts", () => {
    expect([0, 1, 2, 3].map(retryDelay)).toEqual([1, 2, 4, 8]);
  });
});

describe("insertAt", () => {
  it("puts text at the cursor and replaces a selection", () => {
    expect(insertAt("abcd", 2, 2, "X")).toEqual({ value: "abXcd", cursor: 3 });
    expect(insertAt("abcd", 1, 3, "X")).toEqual({ value: "aXd", cursor: 2 });
  });
});

describe("formatBytes", () => {
  it("reads like a person would say it", () => {
    expect(formatBytes(1536)).toBe("2 KB");
    expect(formatBytes(50 * 1024 ** 2)).toBe("50 MB");
    expect(formatBytes(MAX_SUBMISSION_BYTES)).toBe("2.0 GB");
  });
});
