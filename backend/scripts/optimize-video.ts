/**
 * optimize-video — re-compress over-encoded social clips in place.
 *
 * Ingest copies Instagram originals through byte-for-byte (direct-mp4 is the
 * design for social clips), and Instagram hands back whatever the creator's
 * phone produced. Some of those are 720x1280 clips running at over 5 Mbps,
 * roughly three times what vertical 720p needs. They are already fast-start,
 * so they stream; they just stream far more bytes than the picture is worth,
 * which is what makes playback feel unreliable on cellular and what
 * CloudFront egress is billed on.
 *
 * The decision is made on BITRATE, not file size: a long clip encoded sensibly
 * is fine and must not be touched, while a short clip at 6 Mbps is not.
 *
 * Originals are archived to the masters bucket under `originals/` before
 * anything is overwritten, and every job reads from that archive — so the
 * script is idempotent and re-running it can never re-compress an
 * already-compressed file (which would degrade quality each pass). The
 * `originals/` prefix is deliberate: the masters bucket only triggers
 * start-transcode on `masters/`, so archiving here starts no HLS job.
 *
 * Jobs carry userMetadata.purpose = "optimize"; transcode-complete skips those
 * so a finished job cannot repoint a working clip at an HLS manifest that this
 * job never produced.
 *
 *   npx tsx scripts/optimize-video.ts --stage dev --dry-run
 *   npx tsx scripts/optimize-video.ts --stage dev
 *   npx tsx scripts/optimize-video.ts --stage prod --max-mbps 2.5
 */
import { CreateJobCommand, MediaConvertClient } from "@aws-sdk/client-mediaconvert";
import {
  CopyObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListBucketsCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  averageMbps,
  buildOptimizeSettings,
  DEFAULT_MAX_MBPS,
  durationFromMvhd,
  needsOptimizing,
  projectedBytes,
} from "../src/lib/video-optimize";

const REGION = process.env.AWS_REGION ?? "us-east-1";

interface Clip {
  contentId: string;
  key: string;
  bytes: number;
  seconds: number;
  mbps: number;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/**
 * Resolve the stage's media buckets by name.
 *
 * media-stack names them deterministically as
 * `niltv-{stage}-video-{masters|hls}-{account}`, so listing and prefix-matching
 * avoids a CloudFormation dependency this workspace does not carry — and the
 * account id needed for the MediaConvert role/queue ARNs falls out of the
 * bucket name itself.
 */
async function resolveBuckets(s3: S3Client, stage: string) {
  const { Buckets } = await s3.send(new ListBucketsCommand({}));
  const names = (Buckets ?? []).map((b) => b.Name ?? "");
  const find = (kind: "hls" | "masters") => {
    const prefix = `niltv-${stage}-video-${kind}-`;
    const hit = names.find((n) => n.startsWith(prefix));
    if (!hit) throw new Error(`no bucket matching ${prefix}* — is stage "${stage}" deployed?`);
    return hit;
  };
  const hlsBucket = find("hls");
  const mastersBucket = find("masters");
  const account = hlsBucket.slice(`niltv-${stage}-video-hls-`.length);
  if (!/^\d{12}$/.test(account)) {
    throw new Error(`could not read an account id from bucket name "${hlsBucket}"`);
  }
  return { hlsBucket, mastersBucket, account };
}

async function main() {
  const stage = arg("stage") ?? "dev";
  const dryRun = process.argv.includes("--dry-run");
  const maxMbps = Number(arg("max-mbps") ?? DEFAULT_MAX_MBPS);
  if (!Number.isFinite(maxMbps) || maxMbps <= 0) throw new Error("--max-mbps must be a number");

  const s3 = new S3Client({ region: REGION });
  const mc = new MediaConvertClient({ region: REGION });

  const { hlsBucket, mastersBucket, account } = await resolveBuckets(s3, stage);
  const roleArn = `arn:aws:iam::${account}:role/niltv-${stage}-mediaconvert`;
  const queueArn = `arn:aws:mediaconvert:${REGION}:${account}:queues/Default`;

  console.log(`stage=${stage}  hls=${hlsBucket}  masters=${mastersBucket}`);
  console.log(`re-encoding anything above ${maxMbps} Mbps${dryRun ? "  (DRY RUN)" : ""}\n`);

  // ── survey ──────────────────────────────────────────────────────────────
  const clips: Clip[] = [];
  let unmeasured = 0;
  let token: string | undefined;
  do {
    const page = await s3.send(
      new ListObjectsV2Command({ Bucket: hlsBucket, Prefix: "video/", ContinuationToken: token }),
    );
    for (const obj of page.Contents ?? []) {
      if (!obj.Key?.endsWith("/master.mp4") || !obj.Size) continue;
      const contentId = obj.Key.split("/")[1];
      if (!contentId) continue;
      const head = await s3.send(
        new GetObjectCommand({ Bucket: hlsBucket, Key: obj.Key, Range: "bytes=0-65535" }),
      );
      const header = Buffer.from(await head.Body!.transformToByteArray());
      const seconds = durationFromMvhd(header);
      const mbps = averageMbps(obj.Size, seconds);
      if (seconds === null || mbps === null) {
        console.warn(`  ? ${contentId} — could not read duration, leaving alone`);
        unmeasured += 1;
        continue;
      }
      clips.push({ contentId, key: obj.Key, bytes: obj.Size, seconds, mbps });
    }
    token = page.NextContinuationToken;
  } while (token);

  const over = clips
    .filter((c) => needsOptimizing(c.mbps, maxMbps))
    .sort((a, b) => b.bytes - a.bytes);
  const totalBytes = clips.reduce((s, c) => s + c.bytes, 0);
  const overBytes = over.reduce((s, c) => s + c.bytes, 0);

  console.log(`${clips.length} clips measured, ${(totalBytes / 1e9).toFixed(2)} GB total`);
  if (unmeasured > 0) console.log(`${unmeasured} clip(s) unmeasurable and skipped`);
  console.log(`${over.length} over ${maxMbps} Mbps, ${(overBytes / 1e9).toFixed(2)} GB\n`);
  for (const c of over) {
    console.log(
      `  ${c.contentId}  ${(c.bytes / 1e6).toFixed(1).padStart(6)} MB  ` +
        `${c.seconds.toFixed(0).padStart(4)}s  ${c.mbps.toFixed(2)} Mbps`,
    );
  }
  const projected = over.reduce((s, c) => s + projectedBytes(c.bytes, c.mbps), 0);
  const saved = overBytes - projected;
  console.log(
    `\nprojected after re-encode: ${(projected / 1e9).toFixed(2)} GB ` +
      `(saves ~${(saved / 1e9).toFixed(2)} GB, ` +
      `${overBytes > 0 ? ((saved / overBytes) * 100).toFixed(0) : "0"}% of the oversized set)`,
  );

  if (dryRun) {
    console.log("\ndry run — no originals archived, no jobs submitted");
    return;
  }
  if (over.length === 0) {
    console.log("\nnothing to do");
    return;
  }

  // ── archive + submit ────────────────────────────────────────────────────
  let submitted = 0;
  for (const c of over) {
    const archiveKey = `originals/${c.contentId}/master.mp4`;

    // Archive once. If it already exists this clip was processed on an earlier
    // run, and the archive — not the live object — is the encode source, so
    // re-running is safe and cannot compound compression.
    let archived = false;
    try {
      await s3.send(new HeadObjectCommand({ Bucket: mastersBucket, Key: archiveKey }));
      archived = true;
    } catch {
      // Not archived yet — first pass over this clip.
    }
    if (!archived) {
      await s3.send(
        new CopyObjectCommand({
          Bucket: mastersBucket,
          Key: archiveKey,
          CopySource: `${hlsBucket}/${c.key}`,
          MetadataDirective: "COPY",
        }),
      );
    }

    const { Job } = await mc.send(
      new CreateJobCommand({
        Role: roleArn,
        Queue: queueArn,
        Settings: buildOptimizeSettings(
          `s3://${mastersBucket}/${archiveKey}`,
          `s3://${hlsBucket}/video/${c.contentId}/master`,
        ),
        UserMetadata: { contentId: c.contentId, stage, purpose: "optimize" },
      }),
    );
    submitted += 1;
    console.log(
      `  submitted ${Job?.Id ?? "?"}  ${c.contentId}` +
        `${archived ? "  (re-run, original already archived)" : ""}`,
    );
  }

  console.log(
    `\n${submitted} job(s) submitted. Watch: aws mediaconvert list-jobs --status PROGRESSING\n` +
      `Originals are preserved at s3://${mastersBucket}/originals/.\n` +
      `When the queue drains, invalidate /video/* on the stage's distribution.`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
