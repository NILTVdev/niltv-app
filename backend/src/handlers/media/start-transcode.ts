/**
 * start-transcode — S3 ObjectCreated (masters/{contentId}/{filename}) →
 * MediaConvert CreateJob (design §6.8).
 *
 * One inline-settings job per uploaded master: an HLS output group with a
 * three-rendition H264/AAC ladder (1080p/720p/480p, QVBR), a FILE_GROUP
 * frame-capture poster, and — for the partner content API — a FILE_GROUP
 * progressive MP4 mezzanine (H264 High, AAC, moov first) that partners
 * download and transcode themselves. Outputs land in the HLS bucket under
 * video/{contentId}/ and are served by CloudFront at /video/*; the
 * mezzanine is served by the partner download distribution.
 *
 * A second accepted upload name, `vertical.mp4`, is the 9:16 cut of the same
 * asset: it gets a mezzanine-only job (video/{contentId}/vertical.mp4) and
 * never touches the HLS ladder or poster of the horizontal master.
 */
import {
  CreateJobCommand,
  MediaConvertClient,
  type JobSettings,
  type Output,
  type OutputGroup,
} from "@aws-sdk/client-mediaconvert";
import type { S3Handler } from "aws-lambda";

// Modern SDK: the account-specific endpoint is discovered automatically —
// no DescribeEndpoints round-trip needed.
let client: MediaConvertClient | undefined;

function getClient(): MediaConvertClient {
  if (!client) {
    client = new MediaConvertClient({ region: process.env.AWS_REGION ?? "us-east-1" });
  }
  return client;
}

/**
 * Parse a master object key of the exact shape `masters/{contentId}/{filename}`.
 * Returns the contentId, or null when the key is malformed (wrong prefix,
 * missing/empty segments, extra nesting).
 */
export function parseMasterKey(key: string): string | null {
  const parts = key.split("/");
  if (parts.length !== 3) {
    return null;
  }
  const [prefix, contentId, filename] = parts;
  if (prefix !== "masters" || !contentId || !filename) {
    return null;
  }
  return contentId;
}

/** Which upload this is: the horizontal master (full pipeline) or the vertical cut (mezzanine only). */
export function masterVariant(key: string): "master" | "vertical" {
  return key.endsWith("/vertical.mp4") ? "vertical" : "master";
}

interface Rendition {
  nameModifier: string;
  width: number;
  height: number;
  maxBitrate: number;
  qvbrQualityLevel: number;
}

/** H264/AAC HLS ladder (design §6.8): 1080p ~5 Mbps, 720p ~3 Mbps, 480p ~1.2 Mbps. */
const LADDER: Rendition[] = [
  { nameModifier: "_1080p", width: 1920, height: 1080, maxBitrate: 5_000_000, qvbrQualityLevel: 8 },
  { nameModifier: "_720p", width: 1280, height: 720, maxBitrate: 3_000_000, qvbrQualityLevel: 7 },
  { nameModifier: "_480p", width: 854, height: 480, maxBitrate: 1_200_000, qvbrQualityLevel: 7 },
];

function hlsRendition(r: Rendition): Output {
  return {
    NameModifier: r.nameModifier,
    ContainerSettings: { Container: "M3U8" },
    VideoDescription: {
      Width: r.width,
      Height: r.height,
      CodecSettings: {
        Codec: "H_264",
        H264Settings: {
          RateControlMode: "QVBR",
          MaxBitrate: r.maxBitrate,
          QvbrSettings: { QvbrQualityLevel: r.qvbrQualityLevel },
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
  };
}

/**
 * The partner mezzanine: one progressive MP4 at source resolution, H264 High
 * profile at up to 8 Mbps QVBR (a partner's transcode is capped by what we
 * hand it), AAC 192 kbps, moov atom first so byte-range streaming and
 * seeking work straight off the CDN. MediaConvert appends `.mp4` to the
 * destination base name.
 */
export function mezzanineGroup(destination: string, name: string): OutputGroup {
  return {
    Name: name,
    OutputGroupSettings: {
      Type: "FILE_GROUP_SETTINGS",
      FileGroupSettings: { Destination: destination },
    },
    Outputs: [
      {
        ContainerSettings: {
          Container: "MP4",
          Mp4Settings: { MoovPlacement: "PROGRESSIVE_DOWNLOAD" },
        },
        VideoDescription: {
          CodecSettings: {
            Codec: "H_264",
            H264Settings: {
              RateControlMode: "QVBR",
              MaxBitrate: 8_000_000,
              QvbrSettings: { QvbrQualityLevel: 9 },
              CodecProfile: "HIGH",
              SceneChangeDetect: "TRANSITION_DETECTION",
            },
          },
        },
        AudioDescriptions: [
          {
            AudioSourceName: "Audio Selector 1",
            CodecSettings: {
              Codec: "AAC",
              AacSettings: { Bitrate: 192_000, CodingMode: "CODING_MODE_2_0", SampleRate: 48_000 },
            },
          },
        ],
      },
    ],
  };
}

export interface JobParams {
  contentId: string;
  /** s3://bucket/key of the uploaded master. */
  inputUri: string;
  /** Name of the HLS output bucket. */
  outputBucket: string;
}

const inputs = (inputUri: string): JobSettings["Inputs"] => [
  {
    FileInput: inputUri,
    TimecodeSource: "ZEROBASED",
    AudioSelectors: { "Audio Selector 1": { DefaultSelection: "DEFAULT" } },
    VideoSelector: {},
  },
];

/**
 * Inline job settings. Output layout in the HLS bucket:
 *
 *   video/{contentId}/index.m3u8            top-level HLS manifest
 *   video/{contentId}/index_{rung}.m3u8     per-rendition playlists (+ segments)
 *   video/{contentId}/poster.0000000.jpg    frame capture (MediaConvert appends
 *                                           a 7-digit sequence number to
 *                                           frame-capture outputs)
 *   video/{contentId}/mezz.mp4              partner mezzanine (progressive MP4)
 */
export function buildJobSettings({ contentId, inputUri, outputBucket }: JobParams): JobSettings {
  const destinationBase = `s3://${outputBucket}/video/${contentId}`;
  return {
    Inputs: inputs(inputUri),
    OutputGroups: [
      {
        Name: "HLS",
        OutputGroupSettings: {
          Type: "HLS_GROUP_SETTINGS",
          HlsGroupSettings: {
            Destination: `${destinationBase}/index`,
            SegmentLength: 6,
            MinSegmentLength: 2,
          },
        },
        Outputs: LADDER.map(hlsRendition),
      },
      {
        Name: "Poster",
        OutputGroupSettings: {
          Type: "FILE_GROUP_SETTINGS",
          FileGroupSettings: { Destination: `${destinationBase}/poster` },
        },
        Outputs: [
          {
            ContainerSettings: { Container: "RAW" },
            VideoDescription: {
              Width: 1280,
              Height: 720,
              CodecSettings: {
                Codec: "FRAME_CAPTURE",
                // One capture (the first frame sampled at 1 frame / 5s).
                FrameCaptureSettings: {
                  FramerateNumerator: 1,
                  FramerateDenominator: 5,
                  MaxCaptures: 1,
                  Quality: 80,
                },
              },
            },
          },
        ],
      },
      mezzanineGroup(`${destinationBase}/mezz`, "Mezzanine"),
    ],
  };
}

/** Job settings for the vertical cut: the mezzanine only, to video/{contentId}/vertical.mp4. */
export function buildVerticalJobSettings({ contentId, inputUri, outputBucket }: JobParams): JobSettings {
  return {
    Inputs: inputs(inputUri),
    OutputGroups: [mezzanineGroup(`s3://${outputBucket}/video/${contentId}/vertical`, "Vertical")],
  };
}

export const handler: S3Handler = async (event) => {
  const outputBucket = process.env.OUTPUT_BUCKET ?? "";
  const roleArn = process.env.MEDIACONVERT_ROLE_ARN ?? "";
  const queueArn = process.env.MEDIACONVERT_QUEUE_ARN;
  const stage = process.env.STAGE ?? "dev";

  for (const record of event.Records) {
    const bucket = record.s3.bucket.name;
    // S3 event keys are URL-encoded with '+' for spaces.
    const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, " "));

    const contentId = parseMasterKey(key);
    if (!contentId) {
      // Malformed keys are logged and skipped, never retried — throwing here
      // would just poison the async-invoke retry queue.
      console.error(`start-transcode: ignoring malformed master key "${key}"`);
      continue;
    }

    const variant = masterVariant(key);
    const params: JobParams = { contentId, inputUri: `s3://${bucket}/${key}`, outputBucket };
    const { Job } = await getClient().send(
      new CreateJobCommand({
        Role: roleArn,
        Queue: queueArn,
        Settings: variant === "vertical" ? buildVerticalJobSettings(params) : buildJobSettings(params),
        // The EventBridge COMPLETE/ERROR rule matches on stage and the
        // completion handler reads contentId (and the variant) back from here.
        UserMetadata: variant === "vertical" ? { contentId, stage, purpose: "vertical" } : { contentId, stage },
      }),
    );
    console.log(`start-transcode: created ${variant} job ${Job?.Id ?? "?"} for content ${contentId}`);
  }
};
