import { describe, expect, it } from "vitest";
import {
  averageMbps,
  buildOptimizeSettings,
  durationFromMvhd,
  needsOptimizing,
  projectedBytes,
} from "./video-optimize";

/** Build a minimal mvhd atom the way a real MP4 header carries it. */
function mvhd(version: 0 | 1, timescale: number, duration: number): Buffer {
  const head = Buffer.from([0, 0, 0, 0, ...Buffer.from("mvhd"), version, 0, 0, 0]);
  if (version === 0) {
    const rest = Buffer.alloc(16);
    rest.writeUInt32BE(0, 0); // creation
    rest.writeUInt32BE(0, 4); // modification
    rest.writeUInt32BE(timescale, 8);
    rest.writeUInt32BE(duration, 12);
    return Buffer.concat([head, rest]);
  }
  const rest = Buffer.alloc(28);
  rest.writeBigUInt64BE(0n, 0); // creation
  rest.writeBigUInt64BE(0n, 8); // modification
  rest.writeUInt32BE(timescale, 16);
  rest.writeBigUInt64BE(BigInt(duration), 20);
  return Buffer.concat([head, rest]);
}

describe("durationFromMvhd", () => {
  it("reads a version 0 header", () => {
    // 90000 ticks/sec over 8,829,000 ticks == 98.1s, the real 69 MB clip.
    expect(durationFromMvhd(mvhd(0, 90_000, 8_829_000))).toBeCloseTo(98.1, 1);
  });

  it("reads a version 1 (64-bit duration) header", () => {
    expect(durationFromMvhd(mvhd(1, 1000, 134_600))).toBeCloseTo(134.6, 1);
  });

  it("returns null when there is no mvhd atom", () => {
    expect(durationFromMvhd(Buffer.from("ftypisommdat"))).toBeNull();
  });

  it("returns null on a truncated header rather than throwing", () => {
    expect(durationFromMvhd(Buffer.from([...Buffer.from("mvhd"), 0, 0, 0, 0]))).toBeNull();
  });

  it("returns null on a zero timescale", () => {
    expect(durationFromMvhd(mvhd(0, 0, 1000))).toBeNull();
  });
});

describe("averageMbps", () => {
  it("matches the measured 69 MB / 98.1 s clip", () => {
    expect(averageMbps(69_100_000, 98.1)).toBeCloseTo(5.64, 2);
  });

  it("matches a healthy short clip", () => {
    expect(averageMbps(632_492, 5.3)).toBeCloseTo(0.95, 2);
  });

  it("returns null for unknown duration", () => {
    expect(averageMbps(1000, null)).toBeNull();
    expect(averageMbps(1000, 0)).toBeNull();
  });
});

describe("needsOptimizing", () => {
  it("re-encodes clips well over the threshold", () => {
    for (const mbps of [5.64, 5.25, 4.56, 3.17]) {
      expect(needsOptimizing(mbps)).toBe(true);
    }
  });

  it("leaves well-encoded clips alone", () => {
    for (const mbps of [1.69, 0.96, 2.5]) {
      expect(needsOptimizing(mbps)).toBe(false);
    }
  });

  it("does not churn clips that would barely shrink", () => {
    // A re-encode is lossy. Anything close to the 2 Mbps target must be left
    // as-is rather than rewritten for a saving it can never recover.
    for (const mbps of [2.57, 2.72, 2.92]) {
      expect(needsOptimizing(mbps)).toBe(false);
    }
  });

  it("never re-encodes a clip whose bitrate could not be measured", () => {
    expect(needsOptimizing(null)).toBe(false);
  });

  it("honours a caller-supplied threshold", () => {
    expect(needsOptimizing(2.0, 1.5)).toBe(true);
    expect(needsOptimizing(2.0, 3.0)).toBe(false);
  });
});

describe("projectedBytes", () => {
  it("scales the worst clip down by the bitrate ratio", () => {
    // 69.1 MB at 5.64 Mbps re-encoded at a 2 Mbps cap.
    expect(projectedBytes(69_100_000, 5.64) / 1e6).toBeCloseTo(24.5, 0);
  });

  it("never projects a clip larger than it already is", () => {
    expect(projectedBytes(5_000_000, 1.2)).toBe(5_000_000);
  });
});

describe("buildOptimizeSettings", () => {
  const settings = buildOptimizeSettings(
    "s3://masters/originals/ig-1/master.mp4",
    "s3://hls/video/ig-1/master",
  );

  it("reads the archived original, not the live object", () => {
    expect(settings.Inputs?.[0]?.FileInput).toBe("s3://masters/originals/ig-1/master.mp4");
  });

  it("writes back to the served path so no row update is needed", () => {
    const group = settings.OutputGroups?.[0]?.OutputGroupSettings?.FileGroupSettings;
    expect(group?.Destination).toBe("s3://hls/video/ig-1/master");
  });

  it("keeps the moov atom at the front (progressive playback)", () => {
    const container = settings.OutputGroups?.[0]?.Outputs?.[0]?.ContainerSettings;
    expect(container?.Container).toBe("MP4");
    expect(container?.Mp4Settings?.MoovPlacement).toBe("PROGRESSIVE_DOWNLOAD");
  });

  it("caps the bitrate and leaves resolution at the source", () => {
    const video = settings.OutputGroups?.[0]?.Outputs?.[0]?.VideoDescription;
    expect(video?.CodecSettings?.H264Settings?.MaxBitrate).toBe(2_000_000);
    expect(video?.CodecSettings?.H264Settings?.RateControlMode).toBe("QVBR");
    expect(video?.Width).toBeUndefined();
    expect(video?.Height).toBeUndefined();
  });

  it("emits exactly one output so the file lands as master.mp4", () => {
    expect(settings.OutputGroups).toHaveLength(1);
    expect(settings.OutputGroups?.[0]?.Outputs).toHaveLength(1);
    expect(settings.OutputGroups?.[0]?.Outputs?.[0]?.NameModifier).toBeUndefined();
  });
});
