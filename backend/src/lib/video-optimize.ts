/**
 * Bitrate measurement and MediaConvert settings for re-compressing social
 * clips (scripts/optimize-video.ts, and the ingest bridge's forward guard).
 *
 * Kept out of the script itself so the arithmetic and the job shape can be
 * unit-tested without executing anything against AWS.
 */
import type { JobSettings } from "@aws-sdk/client-mediaconvert";

/**
 * QVBR peak cap and quality level for the re-encode. 2 Mbps at QVBR 7 is about
 * what Reels-grade 720x1280 needs; the encoder spends under the cap wherever
 * the picture allows.
 */
export const TARGET_MAX_BITRATE = 2_000_000;
export const TARGET_QVBR_LEVEL = 7;

/**
 * Above this average bitrate a clip is re-encoded.
 *
 * Deliberately well clear of TARGET_MAX_BITRATE rather than just above it. A
 * re-encode is lossy: putting the threshold at (say) 2.2 Mbps would rewrite a
 * 2.3 Mbps clip for a ~10% saving it can never get back, which is a bad trade.
 * At 3.0 the only clips touched are ones that shed a third or more of their
 * bytes, such as clips running at 4 to 5.6 Mbps.
 */
export const DEFAULT_MAX_MBPS = 3.0;

/**
 * Bytes a clip is expected to occupy after re-encoding. QVBR lands at or under
 * the cap, so the saving scales by target ÷ actual; a clip already below the
 * target is projected unchanged.
 */
export function projectedBytes(bytes: number, mbps: number): number {
  const targetMbps = TARGET_MAX_BITRATE / 1e6;
  return bytes * Math.min(1, targetMbps / mbps);
}

/**
 * Duration in seconds from an MP4's `mvhd` atom.
 *
 * Only the first ~64 KB of the file is needed: every clip in this library is
 * fast-start (moov ahead of mdat), so the header is at the front. Returns null
 * when the atom is absent or malformed — callers skip rather than guess, since
 * a wrong duration produces a wrong bitrate and a wrong re-encode decision.
 *
 * Layout after the 4-byte type: 1 version + 3 flags, then
 *   v0: creation(4) modification(4) timescale(4) duration(4)
 *   v1: creation(8) modification(8) timescale(4) duration(8)
 */
export function durationFromMvhd(header: Buffer): number | null {
  const i = header.indexOf("mvhd");
  if (i < 0) return null;
  const version = header[i + 4];
  try {
    if (version === 0) {
      const timescale = header.readUInt32BE(i + 16);
      const duration = header.readUInt32BE(i + 20);
      return timescale > 0 && duration > 0 ? duration / timescale : null;
    }
    if (version === 1) {
      const timescale = header.readUInt32BE(i + 24);
      const duration = Number(header.readBigUInt64BE(i + 28));
      return timescale > 0 && duration > 0 ? duration / timescale : null;
    }
    return null;
  } catch {
    // Truncated header — the read ran past the buffer.
    return null;
  }
}

/** Average bitrate in Mbps, or null when duration is unknown/zero. */
export function averageMbps(bytes: number, seconds: number | null): number | null {
  if (!seconds || seconds <= 0 || bytes <= 0) return null;
  return (bytes * 8) / seconds / 1e6;
}

/**
 * Whether a clip is over-encoded enough to be worth replacing. Unknown bitrate
 * means "leave it alone" — never re-encode a file we could not measure.
 */
export function needsOptimizing(mbps: number | null, maxMbps: number = DEFAULT_MAX_MBPS): boolean {
  if (mbps === null) return false;
  return mbps > maxMbps;
}

/**
 * Single H264/AAC MP4 output at the source resolution.
 *
 * `MoovPlacement: PROGRESSIVE_DOWNLOAD` is not optional — these files are
 * streamed progressively by the feed, and an index written at the end would
 * force the whole file to land before the first frame appears.
 *
 * Resolution is deliberately not set: the library is already 720x1280 and
 * downscaling would be a visible loss for no meaningful saving. All of the
 * reduction comes from rate control.
 */
export function buildOptimizeSettings(inputUri: string, destinationBase: string): JobSettings {
  return {
    Inputs: [
      {
        FileInput: inputUri,
        TimecodeSource: "ZEROBASED",
        AudioSelectors: { "Audio Selector 1": { DefaultSelection: "DEFAULT" } },
        VideoSelector: {},
      },
    ],
    OutputGroups: [
      {
        Name: "MP4",
        OutputGroupSettings: {
          Type: "FILE_GROUP_SETTINGS",
          FileGroupSettings: { Destination: destinationBase },
        },
        Outputs: [
          {
            ContainerSettings: {
              Container: "MP4",
              Mp4Settings: { MoovPlacement: "PROGRESSIVE_DOWNLOAD", CslgAtom: "INCLUDE" },
            },
            VideoDescription: {
              CodecSettings: {
                Codec: "H_264",
                H264Settings: {
                  RateControlMode: "QVBR",
                  MaxBitrate: TARGET_MAX_BITRATE,
                  QvbrSettings: { QvbrQualityLevel: TARGET_QVBR_LEVEL },
                  SceneChangeDetect: "TRANSITION_DETECTION",
                },
              },
            },
            AudioDescriptions: [
              {
                AudioSourceName: "Audio Selector 1",
                CodecSettings: {
                  Codec: "AAC",
                  AacSettings: {
                    Bitrate: 96_000,
                    CodingMode: "CODING_MODE_2_0",
                    SampleRate: 48_000,
                  },
                },
              },
            ],
          },
        ],
      },
    ],
  };
}
