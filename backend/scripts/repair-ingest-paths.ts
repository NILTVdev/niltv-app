/**
 * repair-ingest-paths — restore direct-mp4 playback paths on social rows that
 * were stamped with HLS paths by a transcode COMPLETE event.
 *
 * Social clips are direct-mp4: ingest writes playbackPath
 * `/video/{id}/master.mp4`, thumbPath `/video/{id}/poster.jpg` and
 * transcodeStatus "published". The MediaConvert completion handler assumes any
 * COMPLETE job is a first HLS transcode and rewrites those three fields to
 * `/index.m3u8`, `/poster.0000000.jpg` and "ready" — files a re-compression
 * job never produces, and a status that un-publishes the clip.
 *
 * That happens when re-compression jobs complete under a handler that
 * predates its `purpose: "optimize"` guard. This script puts those rows back.
 *
 * It is deliberately conservative — a row is only touched when
 *   - the id is ingest-sourced (`ig-…`), and
 *   - playbackPath currently points at an HLS manifest, and
 *   - the mp4 and poster it will be pointed at actually exist in S3.
 * Anything else is reported and skipped, so a genuine staff HLS upload can
 * never be dragged onto a direct-mp4 path.
 *
 *   npx tsx scripts/repair-ingest-paths.ts --stage dev --dry-run
 *   npx tsx scripts/repair-ingest-paths.ts --stage dev
 */
import { HeadObjectCommand, ListBucketsCommand, S3Client } from "@aws-sdk/client-s3";
import { ScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { getDocClient } from "../src/lib/db";

const REGION = process.env.AWS_REGION ?? "us-east-1";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function hlsBucketFor(s3: S3Client, stage: string): Promise<string> {
  const { Buckets } = await s3.send(new ListBucketsCommand({}));
  const prefix = `niltv-${stage}-video-hls-`;
  const hit = (Buckets ?? []).map((b) => b.Name ?? "").find((n) => n.startsWith(prefix));
  if (!hit) throw new Error(`no bucket matching ${prefix}*`);
  return hit;
}

async function exists(s3: S3Client, Bucket: string, Key: string): Promise<boolean> {
  try {
    await s3.send(new HeadObjectCommand({ Bucket, Key }));
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const stage = arg("stage") ?? "dev";
  const dryRun = process.argv.includes("--dry-run");
  const table = `niltv-${stage}`;

  const s3 = new S3Client({ region: REGION });
  const doc = getDocClient();
  const bucket = await hlsBucketFor(s3, stage);

  console.log(`table=${table}  bucket=${bucket}${dryRun ? "  (DRY RUN)" : ""}\n`);

  const damaged: { id: string; status: string }[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const page = await doc.send(
      new ScanCommand({
        TableName: table,
        FilterExpression: "begins_with(PK, :c) AND SK = :m AND contains(playbackPath, :hls)",
        ExpressionAttributeValues: { ":c": "CONTENT#ig-", ":m": "META", ":hls": "index.m3u8" },
        ExclusiveStartKey: startKey as never,
      }),
    );
    for (const item of page.Items ?? []) {
      damaged.push({ id: String(item.id), status: String(item.transcodeStatus) });
    }
    startKey = page.LastEvaluatedKey;
  } while (startKey);

  if (damaged.length === 0) {
    console.log("no ingest rows are pointing at HLS paths — nothing to repair");
    return;
  }
  console.log(`${damaged.length} ingest row(s) pointing at HLS paths:\n`);

  let repaired = 0;
  let skipped = 0;
  for (const row of damaged) {
    const mp4Key = `video/${row.id}/master.mp4`;
    const posterKey = `video/${row.id}/poster.jpg`;
    const hasMp4 = await exists(s3, bucket, mp4Key);
    const hasPoster = await exists(s3, bucket, posterKey);

    if (!hasMp4) {
      console.log(`  SKIP ${row.id} — no ${mp4Key} in S3, this may be a real HLS asset`);
      skipped += 1;
      continue;
    }

    console.log(
      `  ${dryRun ? "WOULD FIX" : "FIX"} ${row.id}  status ${row.status} → published` +
        `${hasPoster ? "" : "  (no poster.jpg — thumbPath will be removed)"}`,
    );
    if (dryRun) continue;

    await doc.send(
      new UpdateCommand({
        TableName: table,
        Key: { PK: `CONTENT#${row.id}`, SK: "META" },
        // thumbPath is REMOVEd rather than pointed at a missing file: the app
        // falls back to its gradient card when it is absent, which is correct,
        // whereas a dangling path renders a broken image.
        UpdateExpression: hasPoster
          ? "SET playbackPath = :p, thumbPath = :t, transcodeStatus = :s"
          : "SET playbackPath = :p, transcodeStatus = :s REMOVE thumbPath",
        ExpressionAttributeValues: hasPoster
          ? { ":p": `/${mp4Key}`, ":t": `/${posterKey}`, ":s": "published" }
          : { ":p": `/${mp4Key}`, ":s": "published" },
      }),
    );
    repaired += 1;
  }

  console.log(
    dryRun
      ? `\ndry run — ${damaged.length - skipped} row(s) would be repaired, ${skipped} skipped`
      : `\nrepaired ${repaired} row(s), skipped ${skipped}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
