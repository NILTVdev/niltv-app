/**
 * transcode-complete — EventBridge "MediaConvert Job State Change"
 * (COMPLETE | ERROR, filtered to this stage by the rule) → stamps the
 * transcode outcome onto the CONTENT#{contentId}/META row (design §6.8).
 *
 * COMPLETE → transcodeStatus "ready" + playbackPath/thumbPath (+ duration
 * when MediaConvert reports it) + the partner mezzanine in `files`
 * (partner content API). ERROR → transcodeStatus "failed" + transcodeError
 * for the dashboard to surface.
 *
 * Rows flagged `autoPublish` (the social-ingest bridge) go straight to
 * "published" instead: same publish semantics as the admin publish gate —
 * publishedAt (the source post's original time, so the feed orders by IG
 * post date) + the sparse GSI keys that put the clip into the Watch grid and
 * creator tab. rightsConfirmed is still required; ingest stamps it.
 *
 * Vertical-cut jobs (UserMetadata.purpose = "vertical", see start-transcode)
 * only stamp files.verticalPath: the horizontal master owns playback.
 *
 * playbackPath/thumbPath are stored as PATHS (no domain, no scheme): the
 * read-side handlers compose absolute URLs from the CloudFront domain at
 * request time. Storing the domain here would make this stack depend on the
 * edge stack — a circular stack dependency, since the edge stack already
 * consumes the media stack's output bucket. `files.*` paths are relative to
 * the partner download distribution, whose origin path supplies `/video`.
 */
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { EventBridgeHandler } from "aws-lambda";
import { channelContentGsi1Pk, contentKey, getDocClient, profileKey } from "../../lib/db";

interface OutputGroupDetail {
  type?: string;
  outputDetails?: { durationInMs?: number }[];
  playlistFilePaths?: string[];
}

export interface TranscodeStateChangeDetail {
  status?: string;
  jobId?: string;
  errorCode?: number;
  errorMessage?: string;
  userMetadata?: { contentId?: string; stage?: string; purpose?: string };
  outputGroupDetails?: OutputGroupDetail[];
}

/**
 * Re-compression jobs (scripts/optimize-video.ts) replace an already-published
 * social clip's master.mp4 in place. They must NOT be treated as a first
 * transcode: this handler would stamp playbackPath to an HLS manifest that
 * those jobs never produce and repoint thumbPath at a frame capture that does
 * not exist, breaking playback for every clip it "finished". The row is
 * already correct before an optimize job starts and must be left alone.
 */
export function isOptimizeJob(detail: TranscodeStateChangeDetail): boolean {
  return detail.userMetadata?.purpose === "optimize";
}

/** Vertical-cut jobs stamp one file path and nothing else. */
export function isVerticalJob(detail: TranscodeStateChangeDetail): boolean {
  return detail.userMetadata?.purpose === "vertical";
}

/** First durationInMs MediaConvert reports across output groups, in whole seconds. */
function extractDurationSec(detail: TranscodeStateChangeDetail): number | undefined {
  for (const group of detail.outputGroupDetails ?? []) {
    for (const output of group.outputDetails ?? []) {
      if (typeof output.durationInMs === "number") {
        return Math.round(output.durationInMs / 1000);
      }
    }
  }
  return undefined;
}

const existingFiles = (row: Record<string, unknown> | undefined): Record<string, unknown> => {
  const files = row?.["files"];
  return typeof files === "object" && files !== null && !Array.isArray(files) ? (files as Record<string, unknown>) : {};
};

export const handler: EventBridgeHandler<
  "MediaConvert Job State Change",
  TranscodeStateChangeDetail,
  void
> = async (event) => {
  const detail = event.detail;
  const contentId = detail.userMetadata?.contentId;
  if (!contentId) {
    console.error(
      `transcode-complete: job ${detail.jobId ?? "?"} carries no userMetadata.contentId — ignoring`,
    );
    return;
  }

  if (isOptimizeJob(detail)) {
    console.log(
      `transcode-complete: job ${detail.jobId ?? "?"} is a re-compression of ${contentId} ` +
        `(status ${detail.status ?? "?"}) — leaving the row untouched`,
    );
    return;
  }

  const tableName = process.env.TABLE_NAME ?? "";

  if (isVerticalJob(detail)) {
    if (detail.status !== "COMPLETE") {
      console.error(`transcode-complete: vertical cut for ${contentId} ${detail.status ?? "?"}: ${detail.errorMessage ?? ""}`);
      return;
    }
    const { Item: row } = await getDocClient().send(
      new GetCommand({ TableName: tableName, Key: contentKey(contentId) }),
    );
    await getDocClient().send(
      new UpdateCommand({
        TableName: tableName,
        Key: contentKey(contentId),
        UpdateExpression: "SET #files = :files",
        ExpressionAttributeNames: { "#files": "files" },
        ExpressionAttributeValues: { ":files": { ...existingFiles(row), verticalPath: `/${contentId}/vertical.mp4` } },
      }),
    );
    console.log(`transcode-complete: content ${contentId} vertical cut ready (job ${detail.jobId ?? "?"})`);
    return;
  }

  if (detail.status === "COMPLETE") {
    // Layout written by start-transcode's job settings: the HLS group's
    // Destination …/index yields index.m3u8; the frame-capture poster gets
    // MediaConvert's 7-digit sequence suffix (poster.0000000.jpg); the
    // mezzanine group yields mezz.mp4.
    const setClauses = [
      "transcodeStatus = :transcodeStatus",
      "playbackPath = :playbackPath",
      "thumbPath = :thumbPath",
    ];
    const values: Record<string, unknown> = {
      ":transcodeStatus": "ready",
      ":playbackPath": `/video/${contentId}/index.m3u8`,
      ":thumbPath": `/video/${contentId}/poster.0000000.jpg`,
    };
    const names: Record<string, string> = { "#files": "files" };

    const durationSec = extractDurationSec(detail);
    if (durationSec !== undefined) {
      // Contract spelling (Content.duration) — cards/detail read this attr.
      setClauses.push("#duration = :duration");
      values[":duration"] = durationSec;
      names["#duration"] = "duration";
    }

    // Auto-publish (ingested rows): mirror the admin publish gate's write —
    // published + publishedAt + sparse GSI keys — in the same update, gated
    // on the same rights precondition. The same read supplies the existing
    // `files` map so the mezzanine merges rather than clobbers.
    const { Item: row } = await getDocClient().send(
      new GetCommand({ TableName: tableName, Key: contentKey(contentId) }),
    );
    setClauses.push("#files = :files");
    values[":files"] = {
      ...existingFiles(row),
      mp4Path: `/${contentId}/mezz.mp4`,
      posterPath: `/${contentId}/poster.0000000.jpg`,
    };

    const autoPublish = row?.["autoPublish"] === true && row?.["rightsConfirmed"] === true;
    if (autoPublish && row) {
      const sourcePostedAt = row["sourcePostedAt"];
      const publishedAt =
        typeof sourcePostedAt === "string" && sourcePostedAt.length > 0
          ? sourcePostedAt
          : new Date().toISOString();
      values[":transcodeStatus"] = "published";
      setClauses.push(
        "publishedAt = :publishedAt",
        "GSI1PK = :gsi1pk",
        "GSI1SK = :publishedAt",
        "GSI2PK = :gsi2pk",
        "GSI2SK = :publishedAt",
      );
      values[":publishedAt"] = publishedAt;
      values[":gsi1pk"] = channelContentGsi1Pk(String(row["channelId"]));
      values[":gsi2pk"] = profileKey(String(row["athleteId"])).PK;
    }

    await getDocClient().send(
      new UpdateCommand({
        TableName: tableName,
        Key: contentKey(contentId),
        // REMOVE clears a stale error if a retried job succeeded after failing.
        UpdateExpression: `SET ${setClauses.join(", ")} REMOVE transcodeError`,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
      }),
    );
    console.log(
      `transcode-complete: content ${contentId} ${autoPublish ? "published (auto)" : "ready"} (job ${detail.jobId ?? "?"})`,
    );
    return;
  }

  if (detail.status === "ERROR") {
    const message =
      detail.errorMessage ?? `MediaConvert job failed (code ${detail.errorCode ?? "unknown"})`;
    await getDocClient().send(
      new UpdateCommand({
        TableName: tableName,
        Key: contentKey(contentId),
        UpdateExpression: "SET transcodeStatus = :transcodeStatus, transcodeError = :transcodeError",
        ExpressionAttributeValues: {
          ":transcodeStatus": "failed",
          ":transcodeError": message,
        },
      }),
    );
    console.error(
      `transcode-complete: content ${contentId} failed (job ${detail.jobId ?? "?"}): ${message}`,
    );
    return;
  }

  // The EventBridge rule only forwards COMPLETE/ERROR; anything else is noise.
  console.error(`transcode-complete: ignoring unexpected status "${detail.status ?? "?"}"`);
};
