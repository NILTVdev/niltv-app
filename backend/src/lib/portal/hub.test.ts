import { MAX_SUBMISSION_BYTES, SUBMISSION_PART_BYTES, submissionParts, submissionTypeAllowed } from "@niltv/types";
import { describe, expect, it } from "vitest";
import { CLAIM_FROM, canChangeFiles, fileKey, partsMatch, readPartition, safeFileName } from "./hub";

describe("claim moves", () => {
  it("never lets a delivered or submitted claim be given back", () => {
    expect(CLAIM_FROM.release).not.toContain("delivered");
    expect(CLAIM_FROM.release).not.toContain("submitted");
  });

  it("only reviews what was submitted", () => {
    expect(CLAIM_FROM.review).toEqual(["submitted"]);
  });

  it("lets staff change their mind on a declined request, but not a claim in progress", () => {
    expect(CLAIM_FROM.approve).toContain("declined");
    expect(CLAIM_FROM.decline).toEqual(["requested"]);
  });

  it("opens the files only while the athlete holds the work", () => {
    expect(canChangeFiles("claimed")).toBe(true);
    expect(canChangeFiles("changes")).toBe(true);
    for (const status of ["requested", "submitted", "delivered", "declined"] as const) {
      expect(canChangeFiles(status)).toBe(false);
    }
  });
});

describe("file names", () => {
  it("keeps a plain name", () => {
    expect(safeFileName("clip_1.mov")).toBe("clip_1.mov");
  });

  it("strips paths, quotes and spaces", () => {
    expect(safeFileName('../../my "best" clip.mov')).toBe("my_best_clip.mov");
    expect(safeFileName("a\r\nb.mov")).toBe("a_b.mov");
  });

  it("falls back when nothing is left", () => {
    expect(safeFileName("...")).toBe("file");
  });

  it("keeps the extension of a very long name", () => {
    expect(safeFileName(`${"x".repeat(300)}.mov`).endsWith(".mov")).toBe(true);
  });

  it("files every upload under the submissions prefix, never masters", () => {
    expect(fileKey("ask-1", "sub", "file-1", "a.mov")).toBe("submissions/ask-1/sub/file-1/a.mov");
  });
});

describe("what can be sent", () => {
  it("takes video, audio and photos", () => {
    for (const type of ["video/mp4", "video/quicktime", "audio/mpeg", "image/heic"]) {
      expect(submissionTypeAllowed(type)).toBe(true);
    }
  });

  it("refuses anything that could run in a browser", () => {
    for (const type of ["text/html", "image/svg+xml", "application/pdf", "", "video/mp4; x=<script>"]) {
      expect(submissionTypeAllowed(type)).toBe(false);
    }
  });

  it("fits 2 GB inside the part limit", () => {
    expect(submissionParts(MAX_SUBMISSION_BYTES)).toBe(128);
    expect(submissionParts(1)).toBe(1);
    expect(submissionParts(SUBMISSION_PART_BYTES + 1)).toBe(2);
  });
});

describe("partsMatch", () => {
  it("needs every part and the exact size", () => {
    const parts = [{ size: 10 }, { size: 5 }];
    expect(partsMatch(parts, 2, 15)).toBe(true);
    expect(partsMatch(parts, 3, 15)).toBe(false);
    expect(partsMatch(parts, 2, 14)).toBe(false);
  });
});

describe("readPartition", () => {
  const at = "2026-11-05T12:00:00.000Z";
  const file = (id: string, state: string, stamp = at) => ({
    SK: `FILE#s1#${id}`,
    sub: "s1",
    id,
    name: `${id}.mov`,
    size: 5,
    type: "video/mp4",
    key: "k",
    state,
    at: stamp,
  });

  it("sorts rows into claims, landed files and open uploads", () => {
    const out = readPartition([
      { SK: "META", id: "a" },
      { SK: "CLAIM#s1", sub: "s1", status: "claimed", at },
      file("b", "ready", "2026-11-05T13:00:00.000Z"),
      file("a", "ready"),
      file("c", "uploading"),
    ]);
    expect(out.claims.map((c) => c.sub)).toEqual(["s1"]);
    expect(out.files.get("s1")?.map((f) => f.id)).toEqual(["a", "b"]);
    expect(out.uploading.map((f) => f.id)).toEqual(["c"]);
  });
});
