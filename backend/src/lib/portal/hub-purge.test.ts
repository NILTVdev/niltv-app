import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ db: vi.fn(), s3: vi.fn() }));

vi.mock("../db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../db")>()),
  getDocClient: () => ({ send: m.db }),
}));
vi.mock("@aws-sdk/client-s3", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@aws-sdk/client-s3")>()),
  S3Client: class {
    send = m.s3;
  },
}));

import { PURGE_CONCURRENCY, purgeHubData } from "./hub-purge";

type Cmd = { constructor: { name: string }; input: Record<string, any> };
const calls = (fn: typeof m.db) => fn.mock.calls.map((c) => ({ kind: (c[0] as Cmd).constructor.name, input: (c[0] as Cmd).input }));

beforeEach(() => {
  m.db.mockReset();
  m.s3.mockReset();
  m.db.mockImplementation(async (cmd: Cmd) => {
    if (cmd.constructor.name === "QueryCommand") {
      if (cmd.input.IndexName) return { Items: [{ id: "ask-1" }, { id: "ask-2" }] };
      if (cmd.input.ExpressionAttributeValues[":pk"] === "ASK#ask-1") {
        return {
          Items: [
            { PK: "ASK#ask-1", SK: "FILE#u-1#file-a", key: "submissions/ask-1/u-1/file-a/clip.mp4" },
            { PK: "ASK#ask-1", SK: "FILE#u-1#file-b", key: "submissions/ask-1/u-1/file-b/raw.mov", uploadId: "up-1" },
          ],
        };
      }
      return { Items: [] };
    }
    if (cmd.constructor.name === "DeleteCommand" && cmd.input.Key.SK === "CLAIM#u-1") {
      return cmd.input.Key.PK === "ASK#ask-1" ? { Attributes: { sub: "u-1" } } : {};
    }
    return {};
  });
  m.s3.mockImplementation(async (cmd: Cmd) => {
    if (cmd.constructor.name === "ListObjectsV2Command") {
      return cmd.input.Prefix === "submissions/ask-1/u-1/"
        ? { Contents: [{ Key: "submissions/ask-1/u-1/file-a/clip.mp4" }], IsTruncated: false }
        : { Contents: [], IsTruncated: false };
    }
    return {};
  });
});

describe("purgeHubData", () => {
  it("removes the member's files, file rows and claims across every ask", async () => {
    const result = await purgeHubData("u-1", "bucket", "niltv-test");
    expect(result).toEqual({ asks: 2, rows: 3, objects: 1 });

    const db = calls(m.db);
    expect(db[0]).toMatchObject({ kind: "QueryCommand", input: { IndexName: "GSI1", ExpressionAttributeValues: { ":pk": "ASKS#ALL" } } });
    const deleted = db.filter((c) => c.kind === "DeleteCommand").map((c) => `${c.input.Key.PK}/${c.input.Key.SK}`);
    // Asks run side by side; within one ask the file rows go before the claim.
    expect(deleted.filter((k) => k.startsWith("ASK#ask-1/"))).toEqual([
      "ASK#ask-1/FILE#u-1#file-a",
      "ASK#ask-1/FILE#u-1#file-b",
      "ASK#ask-1/CLAIM#u-1",
    ]);
    expect(deleted.filter((k) => k.startsWith("ASK#ask-2/"))).toEqual(["ASK#ask-2/CLAIM#u-1"]);
    expect(deleted).toHaveLength(4);

    const s3 = calls(m.s3);
    expect(s3.find((c) => c.kind === "AbortMultipartUploadCommand")?.input).toMatchObject({ UploadId: "up-1" });
    expect(s3.filter((c) => c.kind === "ListObjectsV2Command").map((c) => c.input.Prefix).sort()).toEqual([
      "submissions/ask-1/u-1/",
      "submissions/ask-2/u-1/",
    ]);
    expect(s3.find((c) => c.kind === "DeleteObjectsCommand")?.input.Delete.Objects).toEqual([
      { Key: "submissions/ask-1/u-1/file-a/clip.mp4" },
    ]);
  });

  it("deletes the files before the rows, so a retry still finds them", async () => {
    await purgeHubData("u-1", "bucket", "niltv-test");
    const firstRowDelete = m.db.mock.calls.findIndex(
      (c) => (c[0] as Cmd).constructor.name === "DeleteCommand" && (c[0] as Cmd).input.Key.PK === "ASK#ask-1",
    );
    const ask1ObjectsDeleted = m.s3.mock.calls.findIndex((c) => (c[0] as Cmd).constructor.name === "DeleteObjectsCommand");
    expect(m.db.mock.invocationCallOrder[firstRowDelete]!).toBeGreaterThan(m.s3.mock.invocationCallOrder[ask1ObjectsDeleted]!);
  });

  it("works through many asks a bounded number at a time", async () => {
    const ids = Array.from({ length: 500 }, (_, i) => ({ id: `ask-${i}` }));
    let inFlight = 0;
    let peak = 0;
    m.db.mockImplementation(async (cmd: Cmd) => {
      if (cmd.constructor.name === "QueryCommand" && cmd.input.IndexName) return { Items: ids };
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      return cmd.constructor.name === "QueryCommand" ? { Items: [] } : {};
    });
    m.s3.mockResolvedValue({ Contents: [], IsTruncated: false });
    const result = await purgeHubData("u-1", "bucket", "niltv-test");
    expect(result.asks).toBe(500);
    expect(m.s3).toHaveBeenCalledTimes(500);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(PURGE_CONCURRENCY);
  });

  it("fails the purge when one ask fails, so delete-me stops before Cognito", async () => {
    m.s3.mockRejectedValue(Object.assign(new Error("denied"), { name: "AccessDenied" }));
    await expect(purgeHubData("u-1", "bucket", "niltv-test")).rejects.toThrow("denied");
  });

  it("does nothing more than the ask listing when there are no asks", async () => {
    m.db.mockResolvedValue({ Items: [] });
    expect(await purgeHubData("u-1", "bucket", "niltv-test")).toEqual({ asks: 0, rows: 0, objects: 0 });
    expect(m.s3).not.toHaveBeenCalled();
  });
});
