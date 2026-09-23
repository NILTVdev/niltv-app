import { beforeEach, describe, expect, it, vi } from "vitest";

const sendMock = vi.hoisted(() => vi.fn());
const listTargetUserIdsMock = vi.hoisted(() => vi.fn());
const pushToUsersMock = vi.hoisted(() => vi.fn());

vi.mock("../lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/db")>();
  return {
    ...actual,
    getDocClient: () => ({ send: sendMock }),
  };
});

vi.mock("../lib/push", () => ({
  listTargetUserIds: listTargetUserIdsMock,
  pushToUsers: pushToUsersMock,
}));

import { handler, isContentPublishEdge } from "./fanout-push";

/** Minimal marshalled stream record for a CONTENT META image pair. */
const record = (
  newAttrs: Record<string, string> | undefined,
  oldAttrs: Record<string, string> | undefined,
  seq = "seq-1",
) => ({
  dynamodb: {
    SequenceNumber: seq,
    ...(newAttrs
      ? { NewImage: Object.fromEntries(Object.entries(newAttrs).map(([k, v]) => [k, { S: v }])) }
      : {}),
    ...(oldAttrs
      ? { OldImage: Object.fromEntries(Object.entries(oldAttrs).map(([k, v]) => [k, { S: v }])) }
      : {}),
  },
});

const publishedImage = {
  PK: "CONTENT#c-1",
  SK: "META",
  id: "c-1",
  title: "Springtime dunk mix",
  channelId: "ch-tbtv",
  athleteId: "ath-camila",
  transcodeStatus: "published",
};

describe("isContentPublishEdge (design §6.4 trigger)", () => {
  it("fires on ready → published", () => {
    expect(
      isContentPublishEdge(publishedImage, { ...publishedImage, transcodeStatus: "ready" }),
    ).toBe(true);
  });

  it("fires on an insert already published (seeded rows)", () => {
    expect(isContentPublishEdge(publishedImage, undefined)).toBe(true);
  });

  it("ignores republished no-ops, non-content rows and other statuses", () => {
    expect(isContentPublishEdge(publishedImage, publishedImage)).toBe(false);
    expect(isContentPublishEdge({ ...publishedImage, transcodeStatus: "ready" }, undefined)).toBe(false);
    expect(isContentPublishEdge({ ...publishedImage, PK: "EVENT#e-1" }, undefined)).toBe(false);
    expect(isContentPublishEdge({ ...publishedImage, SK: "ENTRY#x" }, undefined)).toBe(false);
    expect(isContentPublishEdge(undefined, publishedImage)).toBe(false);
  });
});

describe("fanout-push stream handler", () => {
  beforeEach(() => {
    sendMock.mockReset();
    sendMock.mockResolvedValue({ Item: { name: "TrueBlue TV" } });
    listTargetUserIdsMock.mockReset();
    pushToUsersMock.mockReset();
    pushToUsersMock.mockResolvedValue({ sent: 2, pruned: 0 });
    process.env.TABLE_NAME = "niltv-test";
  });

  it("unions channel + ambassador audiences, deduped, and deep-links the clip", async () => {
    listTargetUserIdsMock
      .mockResolvedValueOnce(["u-1", "u-2"]) // channel opt-ins
      .mockResolvedValueOnce(["u-2", "u-3"]); // ambassador opt-ins

    const res = await handler({
      Records: [record(publishedImage, { ...publishedImage, transcodeStatus: "ready" })],
    } as never);

    expect(res.batchItemFailures).toEqual([]);
    expect(listTargetUserIdsMock).toHaveBeenCalledWith("channel", "ch-tbtv");
    expect(listTargetUserIdsMock).toHaveBeenCalledWith("ambassador", "ath-camila");

    const [audience, notification] = pushToUsersMock.mock.calls[0] as [Set<string>, Record<string, any>];
    expect([...audience].sort()).toEqual(["u-1", "u-2", "u-3"]);
    expect(notification).toMatchObject({
      title: "New on TrueBlue TV",
      body: "Springtime dunk mix",
      data: { url: "/video/c-1" },
    });
  });

  it("skips non-publish records without touching the push path", async () => {
    const res = await handler({
      Records: [record({ ...publishedImage, transcodeStatus: "processing" }, undefined)],
    } as never);
    expect(res.batchItemFailures).toEqual([]);
    expect(pushToUsersMock).not.toHaveBeenCalled();
  });

  it("an empty audience sends nothing", async () => {
    listTargetUserIdsMock.mockResolvedValue([]);
    await handler({ Records: [record(publishedImage, undefined)] } as never);
    expect(pushToUsersMock).not.toHaveBeenCalled();
  });

  it("reports only the failing record so the shard is never blocked by a neighbor", async () => {
    listTargetUserIdsMock.mockResolvedValue(["u-1"]);
    pushToUsersMock
      .mockRejectedValueOnce(new Error("expo down"))
      .mockResolvedValueOnce({ sent: 1, pruned: 0 });

    const res = await handler({
      Records: [
        record(publishedImage, undefined, "seq-fail"),
        record({ ...publishedImage, PK: "CONTENT#c-2", id: "c-2" }, undefined, "seq-ok"),
      ],
    } as never);

    expect(res.batchItemFailures).toEqual([{ itemIdentifier: "seq-fail" }]);
  });
});
