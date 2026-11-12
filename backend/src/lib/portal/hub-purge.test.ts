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

import { purgeHubData } from "./hub-purge";

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
    expect(deleted).toEqual([
      "ASK#ask-1/FILE#u-1#file-a",
      "ASK#ask-1/FILE#u-1#file-b",
      "ASK#ask-1/CLAIM#u-1",
      "ASK#ask-2/CLAIM#u-1",
    ]);

    const s3 = calls(m.s3);
    expect(s3.find((c) => c.kind === "AbortMultipartUploadCommand")?.input).toMatchObject({ UploadId: "up-1" });
    expect(s3.filter((c) => c.kind === "ListObjectsV2Command").map((c) => c.input.Prefix)).toEqual([
      "submissions/ask-1/u-1/",
      "submissions/ask-2/u-1/",
    ]);
    expect(s3.find((c) => c.kind === "DeleteObjectsCommand")?.input.Delete.Objects).toEqual([
      { Key: "submissions/ask-1/u-1/file-a/clip.mp4" },
    ]);
  });

  it("deletes the files before the rows, so a retry still finds them", async () => {
    await purgeHubData("u-1", "bucket", "niltv-test");
    const firstRowDelete = m.db.mock.calls.findIndex((c) => (c[0] as Cmd).constructor.name === "DeleteCommand");
    // ask-1's S3 calls: abort the open upload, list, delete objects.
    const ask1ObjectsDeleted = m.s3.mock.invocationCallOrder[2]!;
    expect(m.db.mock.invocationCallOrder[firstRowDelete]!).toBeGreaterThan(ask1ObjectsDeleted);
  });

  it("does nothing more than the ask listing when there are no asks", async () => {
    m.db.mockResolvedValue({ Items: [] });
    expect(await purgeHubData("u-1", "bucket", "niltv-test")).toEqual({ asks: 0, rows: 0, objects: 0 });
    expect(m.s3).not.toHaveBeenCalled();
  });
});
