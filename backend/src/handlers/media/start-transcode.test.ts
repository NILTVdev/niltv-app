import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sendMock = vi.hoisted(() => vi.fn());

vi.mock("@aws-sdk/client-mediaconvert", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aws-sdk/client-mediaconvert")>();
  return {
    ...actual,
    MediaConvertClient: class {
      send = sendMock;
    },
  };
});

import { buildJobSettings, handler, parseMasterKey } from "./start-transcode";

function s3Event(key: string, bucket = "niltv-test-video-masters-123") {
  return { Records: [{ s3: { bucket: { name: bucket }, object: { key } } }] };
}

async function invoke(event: Record<string, unknown>) {
  await handler(event as never, {} as never, () => undefined);
}

describe("parseMasterKey", () => {
  it("extracts the contentId from masters/{contentId}/{filename}", () => {
    expect(parseMasterKey("masters/c_abc123/original.mp4")).toBe("c_abc123");
  });

  it.each([
    ["wrong prefix", "uploads/c_abc/original.mp4"],
    ["no filename segment", "masters/c_abc"],
    ["empty contentId", "masters//original.mp4"],
    ["empty filename", "masters/c_abc/"],
    ["extra nesting", "masters/c_abc/sub/original.mp4"],
    ["bare prefix", "masters/"],
  ])("rejects a malformed key (%s)", (_label, key) => {
    expect(parseMasterKey(key)).toBeNull();
  });
});

describe("buildJobSettings", () => {
  const settings = buildJobSettings({
    contentId: "c_abc",
    inputUri: "s3://masters-bucket/masters/c_abc/original.mp4",
    outputBucket: "hls-bucket",
  });

  it("reads the master as the file input", () => {
    expect(settings.Inputs).toHaveLength(1);
    expect(settings.Inputs?.[0]?.FileInput).toBe("s3://masters-bucket/masters/c_abc/original.mp4");
  });

  it("has one HLS group (6s segments, min 2) targeting video/{contentId}/index", () => {
    const hls = settings.OutputGroups?.find((g) => g.OutputGroupSettings?.Type === "HLS_GROUP_SETTINGS");
    expect(hls).toBeDefined();
    const groupSettings = hls?.OutputGroupSettings?.HlsGroupSettings;
    expect(groupSettings?.Destination).toBe("s3://hls-bucket/video/c_abc/index");
    expect(groupSettings?.SegmentLength).toBe(6);
    expect(groupSettings?.MinSegmentLength).toBe(2);
  });

  it("carries the three-rendition H264/AAC QVBR ladder with per-rendition name modifiers", () => {
    const hls = settings.OutputGroups?.find((g) => g.OutputGroupSettings?.Type === "HLS_GROUP_SETTINGS");
    const outputs = hls?.Outputs ?? [];
    expect(outputs).toHaveLength(3);

    expect(outputs.map((o) => o.NameModifier)).toEqual(["_1080p", "_720p", "_480p"]);
    expect(outputs.map((o) => o.VideoDescription?.Height)).toEqual([1080, 720, 480]);
    expect(outputs.map((o) => o.VideoDescription?.CodecSettings?.H264Settings?.MaxBitrate)).toEqual([
      5_000_000, 3_000_000, 1_200_000,
    ]);
    for (const output of outputs) {
      expect(output.VideoDescription?.CodecSettings?.Codec).toBe("H_264");
      expect(output.VideoDescription?.CodecSettings?.H264Settings?.RateControlMode).toBe("QVBR");
      expect(output.AudioDescriptions?.[0]?.CodecSettings?.Codec).toBe("AAC");
    }
  });

  it("has a FILE_GROUP frame-capture poster targeting video/{contentId}/poster", () => {
    const fileGroup = settings.OutputGroups?.find(
      (g) => g.OutputGroupSettings?.Type === "FILE_GROUP_SETTINGS",
    );
    expect(fileGroup).toBeDefined();
    expect(fileGroup?.OutputGroupSettings?.FileGroupSettings?.Destination).toBe(
      "s3://hls-bucket/video/c_abc/poster",
    );
    const poster = fileGroup?.Outputs?.[0];
    expect(poster?.VideoDescription?.CodecSettings?.Codec).toBe("FRAME_CAPTURE");
    expect(poster?.VideoDescription?.CodecSettings?.FrameCaptureSettings?.MaxCaptures).toBe(1);
    expect(poster?.ContainerSettings?.Container).toBe("RAW");
  });
});

describe("start-transcode handler", () => {
  beforeEach(() => {
    sendMock.mockReset();
    sendMock.mockResolvedValue({ Job: { Id: "job-1" } });
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    process.env.OUTPUT_BUCKET = "hls-bucket";
    process.env.MEDIACONVERT_ROLE_ARN = "arn:aws:iam::123:role/niltv-test-mediaconvert";
    process.env.MEDIACONVERT_QUEUE_ARN = "arn:aws:mediaconvert:us-east-1:123:queues/Default";
    process.env.STAGE = "test";
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates a MediaConvert job with the execution role and {contentId, stage} metadata", async () => {
    await invoke(s3Event("masters/c_abc/original.mp4"));

    expect(sendMock).toHaveBeenCalledTimes(1);
    const input = sendMock.mock.calls[0]?.[0]?.input;
    expect(input.Role).toBe("arn:aws:iam::123:role/niltv-test-mediaconvert");
    expect(input.Queue).toBe("arn:aws:mediaconvert:us-east-1:123:queues/Default");
    expect(input.UserMetadata).toEqual({ contentId: "c_abc", stage: "test" });
    expect(input.Settings.Inputs[0].FileInput).toBe(
      "s3://niltv-test-video-masters-123/masters/c_abc/original.mp4",
    );
    expect(input.Settings.OutputGroups).toHaveLength(3);
  });

  it("URL-decodes the S3 object key before parsing ('+' means space)", async () => {
    await invoke(s3Event("masters/c_abc/my+clip%281%29.mp4"));

    const input = sendMock.mock.calls[0]?.[0]?.input;
    expect(input.Settings.Inputs[0].FileInput).toBe(
      "s3://niltv-test-video-masters-123/masters/c_abc/my clip(1).mp4",
    );
  });

  it("skips malformed keys without calling MediaConvert", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await invoke(s3Event("not-masters/c_abc/original.mp4"));

    expect(sendMock).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalled();
  });
});
