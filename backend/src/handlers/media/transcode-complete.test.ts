import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sendMock = vi.hoisted(() => vi.fn());

vi.mock("../../lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/db")>();
  return {
    ...actual,
    getDocClient: () => ({ send: sendMock }),
  };
});

import { handler, type TranscodeStateChangeDetail } from "./transcode-complete";

async function invoke(detail: TranscodeStateChangeDetail) {
  await handler(
    { "detail-type": "MediaConvert Job State Change", source: "aws.mediaconvert", detail } as never,
    {} as never,
    () => undefined,
  );
}

function completeDetail(overrides: Partial<TranscodeStateChangeDetail> = {}): TranscodeStateChangeDetail {
  return {
    status: "COMPLETE",
    jobId: "job-1",
    userMetadata: { contentId: "c_abc", stage: "test" },
    outputGroupDetails: [
      {
        type: "HLS_GROUP",
        outputDetails: [{ durationInMs: 30_041 }, { durationInMs: 30_041 }, { durationInMs: 30_041 }],
      },
      { type: "FILE_GROUP", outputDetails: [{}] },
    ],
    ...overrides,
  };
}

describe("transcode-complete handler", () => {
  beforeEach(() => {
    sendMock.mockReset();
    sendMock.mockResolvedValue({});
    process.env.TABLE_NAME = "niltv-test";
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("COMPLETE → marks the CONTENT row ready with playback/thumb paths and duration", async () => {
    await invoke(completeDetail());

    // [0] GetCommand (autoPublish check), [1] UpdateCommand.
    expect(sendMock).toHaveBeenCalledTimes(2);
    const input = sendMock.mock.calls[1]?.[0]?.input;
    expect(input.TableName).toBe("niltv-test");
    // CONTENT#{contentId}/META — via the shared key builder.
    expect(input.Key).toEqual({ PK: "CONTENT#c_abc", SK: "META" });
    expect(input.UpdateExpression).toBe(
      "SET transcodeStatus = :transcodeStatus, playbackPath = :playbackPath, " +
        "thumbPath = :thumbPath, #duration = :duration, #files = :files REMOVE transcodeError",
    );
    // Contract spelling: Content.duration (cards/detail read this attr).
    expect(input.ExpressionAttributeNames).toEqual({ "#duration": "duration", "#files": "files" });
    expect(input.ExpressionAttributeValues).toEqual({
      ":transcodeStatus": "ready",
      // Stored as PATHS (no domain) — read side composes absolute URLs.
      ":playbackPath": "/video/c_abc/index.m3u8",
      ":thumbPath": "/video/c_abc/poster.0000000.jpg",
      ":duration": 30, // 30041 ms rounded
      // Partner mezzanine paths are relative to the partner download
      // distribution, whose origin path supplies /video.
      ":files": { mp4Path: "/c_abc/mezz.mp4", posterPath: "/c_abc/poster.0000000.jpg" },
    });
  });

  it("COMPLETE without durationInMs → omits duration from the update", async () => {
    await invoke(completeDetail({ outputGroupDetails: [{ type: "HLS_GROUP", outputDetails: [{}] }] }));

    const input = sendMock.mock.calls[1]?.[0]?.input;
    expect(input.UpdateExpression).not.toContain("duration");
    expect(input.ExpressionAttributeValues[":duration"]).toBeUndefined();
    expect(input.ExpressionAttributeValues[":playbackPath"]).toBe("/video/c_abc/index.m3u8");
  });

  it("COMPLETE on an autoPublish row → publishes with source-post time and GSI keys", async () => {
    // First send = GetCommand → the ingested row; second = UpdateCommand.
    sendMock.mockResolvedValueOnce({
      Item: {
        autoPublish: true,
        rightsConfirmed: true,
        channelId: "ch-chapelhilltv",
        athleteId: "p-chapelhilltv",
        sourcePostedAt: "2026-08-03T20:55:05.000Z",
      },
    });
    await invoke(completeDetail());

    const input = sendMock.mock.calls[1]?.[0]?.input;
    expect(input.ExpressionAttributeValues[":transcodeStatus"]).toBe("published");
    expect(input.ExpressionAttributeValues[":publishedAt"]).toBe("2026-08-03T20:55:05.000Z");
    expect(input.ExpressionAttributeValues[":gsi1pk"]).toBe("CHANNEL#ch-chapelhilltv");
    expect(input.ExpressionAttributeValues[":gsi2pk"]).toBe("ATHLETE#p-chapelhilltv");
    expect(input.UpdateExpression).toContain("GSI1PK = :gsi1pk");
    expect(input.UpdateExpression).toContain("GSI2SK = :publishedAt");
  });

  it("COMPLETE on an autoPublish row WITHOUT rightsConfirmed → stays ready (never publishes)", async () => {
    sendMock.mockResolvedValueOnce({
      Item: { autoPublish: true, rightsConfirmed: false, channelId: "ch-x", athleteId: "p-x" },
    });
    await invoke(completeDetail());

    const input = sendMock.mock.calls[1]?.[0]?.input;
    expect(input.ExpressionAttributeValues[":transcodeStatus"]).toBe("ready");
    expect(input.UpdateExpression).not.toContain("GSI1PK");
  });

  it("ERROR → marks the row failed and stores the MediaConvert error message", async () => {
    await invoke({
      status: "ERROR",
      jobId: "job-2",
      errorCode: 1040,
      errorMessage: "Input file is unsupported",
      userMetadata: { contentId: "c_abc", stage: "test" },
    });

    expect(sendMock).toHaveBeenCalledTimes(1);
    const input = sendMock.mock.calls[0]?.[0]?.input;
    expect(input.Key).toEqual({ PK: "CONTENT#c_abc", SK: "META" });
    expect(input.UpdateExpression).toBe(
      "SET transcodeStatus = :transcodeStatus, transcodeError = :transcodeError",
    );
    expect(input.ExpressionAttributeValues).toEqual({
      ":transcodeStatus": "failed",
      ":transcodeError": "Input file is unsupported",
    });
  });

  it("ERROR without an errorMessage → stores a fallback that carries the error code", async () => {
    await invoke({
      status: "ERROR",
      errorCode: 1010,
      userMetadata: { contentId: "c_abc", stage: "test" },
    });

    const input = sendMock.mock.calls[0]?.[0]?.input;
    expect(input.ExpressionAttributeValues[":transcodeError"]).toContain("1010");
  });

  it("ignores events without userMetadata.contentId (no table write)", async () => {
    await invoke({ status: "COMPLETE", jobId: "job-3", userMetadata: {} });

    expect(sendMock).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalled();
  });

  // Re-compression jobs replace an existing social clip's master.mp4 and
  // produce no HLS manifest and no frame capture. Stamping the normal COMPLETE
  // attributes on them would repoint a working clip at /index.m3u8 — a file
  // that does not exist — and break playback for everything it touched.
  it("leaves the row untouched for a re-compression COMPLETE", async () => {
    await invoke({
      status: "COMPLETE",
      jobId: "job-opt",
      userMetadata: { contentId: "c_abc", stage: "test", purpose: "optimize" },
      outputGroupDetails: [{ type: "FILE_GROUP", outputDetails: [{ durationInMs: 30_000 }] }],
    });

    expect(sendMock).not.toHaveBeenCalled();
  });

  it("leaves the row untouched for a re-compression ERROR", async () => {
    // A failed re-compression means the original is still in place and serving.
    // Marking the content "failed" would hide a clip that plays perfectly well.
    await invoke({
      status: "ERROR",
      jobId: "job-opt-2",
      errorCode: 1010,
      errorMessage: "boom",
      userMetadata: { contentId: "c_abc", stage: "test", purpose: "optimize" },
    });

    expect(sendMock).not.toHaveBeenCalled();
  });
});
