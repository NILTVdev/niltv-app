/**
 * Remove one content item from the app: S3 media deleted, its edge cache
 * invalidated, DynamoDB row REPLACED WITH A TOMBSTONE (lib/db
 * contentTombstone). Dev and prod by default, one stage with --stage.
 *
 * DEPLOY FIRST. The tombstone is only harmless to handlers that know it.
 * Before the first run on a stage:
 *
 *   cd backend && npx cdk deploy -c stage=<stage> niltv-<stage>-admin niltv-<stage>-ingest --exclusively --require-approval never
 *
 * An admin content-list that predates tombstones Content.parse()s every
 * scanned CONTENT row, so the Scan page holding a tombstone 500s the staff
 * library (whole-table Scan, Limit before filter: staff cannot skip the
 * page). An ingest that predates them treats any existing row as "already
 * ingested" and keeps the removed post in library/content-library.csv with
 * a Download Link to the mp4 this script just deleted. Deploy the handler,
 * then start the work that triggers it.
 *
 * Why a tombstone and not a delete: the ingest bridge
 * (handlers/ingest/ingest-social.ts) mirrors every video post the dashboard
 * API serves, whole history, and its dedupe is "CONTENT row exists = skip".
 * A deleted row therefore comes straight back on the next ingest run. A
 * tombstone has no entity fields, no publishedAt and no GSI keys, so every
 * public read and the admin library ignore it while the bridge's existence
 * check still finds it. The tombstone is written even when the row is
 * already absent, for exactly that re-mirror case; the script says so when
 * it happens, so a mistyped id does not read as a removal.
 *
 * Why the edge invalidation: ingest stores master.mp4 and the posters with
 * Cache-Control immutable, max-age one year, and the Download Link in the
 * socials CSV points straight at the CloudFront URL. Deleting the S3 object
 * leaves every edge that already served it serving it, so the script
 * invalidates /video/{id}/* on the stage's distribution too.
 *
 * Ids: ig- (Instagram mirror) and tbtv- (TrueBlue backfill) only. Staff
 * uploads (c-) also carry an HLS ladder under video/{id}/ and a masters/{id}/
 * object this script does not clean; clean those up manually.
 *
 * Run:  npx tsx scripts/remove-content-item.ts ig-XXXX --confirm
 *       npx tsx scripts/remove-content-item.ts ig-XXXX --confirm --stage prod
 *       npx tsx scripts/remove-content-item.ts ig-XXXX --confirm --reason "landscape in portrait canvas"
 *       (--stage=prod and --reason=... work too)
 */
import { CloudFrontClient, CreateInvalidationCommand } from "@aws-sdk/client-cloudfront";
import { DeleteObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { contentKey, contentTombstone, getDocClient } from "../src/lib/db";

// Distribution ids per stage (dev E23CTTFB3RV2CB, prod E2VPOMST073ADA).
const STAGES = {
  dev: { table: "niltv-dev", bucket: "niltv-dev-video-hls-858321320457", distributionId: "E23CTTFB3RV2CB" },
  prod: { table: "niltv-prod", bucket: "niltv-prod-video-hls-858321320457", distributionId: "E2VPOMST073ADA" },
} as const;
type Stage = keyof typeof STAGES;

const ID_PREFIXES = ["ig-", "tbtv-"] as const;
const USAGE = 'usage: <ig-… | tbtv-… content id> --confirm [--stage dev|prod] [--reason "text"]';

interface Args {
  id: string;
  confirm: boolean;
  stage?: Stage;
  reason: string;
}

/** One positional id; --confirm; --stage / --reason as `--flag value` or `--flag=value`; anything else is an error. */
function parseArgs(argv: string[]): Args {
  let id: string | undefined;
  let confirm = false;
  let stage: Stage | undefined;
  let reason = "removed by staff";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (!arg.startsWith("--")) {
      if (id !== undefined) throw new Error(`one id per run (got ${id} and ${arg})\n${USAGE}`);
      id = arg;
      continue;
    }
    const eq = arg.indexOf("=");
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    const takeValue = (): string => {
      if (eq !== -1) return arg.slice(eq + 1);
      const next = argv[++i];
      if (next === undefined || next.startsWith("--")) throw new Error(`${flag} needs a value\n${USAGE}`);
      return next;
    };
    switch (flag) {
      case "--confirm":
        confirm = true;
        break;
      case "--stage": {
        const value = takeValue();
        if (value !== "dev" && value !== "prod") throw new Error(`--stage must be dev or prod\n${USAGE}`);
        stage = value;
        break;
      }
      case "--reason":
        reason = takeValue();
        break;
      default:
        throw new Error(`unknown flag ${flag}\n${USAGE}`);
    }
  }
  if (id === undefined) throw new Error(USAGE);
  if (!ID_PREFIXES.some((p) => id?.startsWith(p))) {
    throw new Error(`${id}: only ${ID_PREFIXES.join("/")} ids (staff c- uploads carry an HLS ladder this script does not clean)\n${USAGE}`);
  }
  if (!confirm) throw new Error(`destructive: pass --confirm\n${USAGE}`);
  return { id, confirm, ...(stage !== undefined ? { stage } : {}), reason };
}

/** master + both poster variants; a key that is already gone is not an error. */
async function deleteMedia(s3: S3Client, bucket: string, id: string): Promise<void> {
  for (const key of [`video/${id}/master.mp4`, `video/${id}/poster.jpg`, `video/${id}/poster-fill.jpg`]) {
    try {
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    } catch (err) {
      if ((err as { name?: string }).name === "NoSuchKey") continue;
      throw err;
    }
  }
}

/**
 * Flush /video/{id}/* at the edge. Best-effort: a failure must not stop the
 * tombstone (a live row pointing at deleted media is worse than a stale
 * edge), so it prints the manual command instead. Double quotes around the
 * path on Windows (CLAUDE.md).
 */
async function invalidateEdge(cf: CloudFrontClient, distributionId: string, id: string): Promise<boolean> {
  const path = `/video/${id}/*`;
  try {
    await cf.send(
      new CreateInvalidationCommand({
        DistributionId: distributionId,
        InvalidationBatch: {
          CallerReference: `remove-content-${id}-${Date.now()}`,
          Paths: { Quantity: 1, Items: [path] },
        },
      }),
    );
    return true;
  } catch (err) {
    console.error(
      `${distributionId}: invalidation failed, run it by hand:\n` +
        `  aws cloudfront create-invalidation --distribution-id ${distributionId} --paths "${path}"`,
      err,
    );
    return false;
  }
}

async function main() {
  process.env["AWS_REGION"] = process.env["AWS_REGION"] ?? "us-east-1";
  const { id, stage, reason } = parseArgs(process.argv.slice(2));
  const stages: Stage[] = stage === undefined ? ["dev", "prod"] : [stage];

  const db = getDocClient();
  const s3 = new S3Client({});
  const cf = new CloudFrontClient({});
  for (const st of stages) {
    const { table, bucket, distributionId } = STAGES[st];
    const { Item } = await db.send(new GetCommand({ TableName: table, Key: contentKey(id) }));
    await deleteMedia(s3, bucket, id);
    const flushed = await invalidateEdge(cf, distributionId, id);
    // Unconditional: an absent row still gets a tombstone, otherwise the
    // bridge re-mirrors the post on its next run.
    await db.send(new PutCommand({ TableName: table, Item: contentTombstone(id, reason) }));
    const edge = flushed ? "edge invalidated" : "EDGE NOT INVALIDATED (see above)";
    if (Item === undefined) {
      console.warn(
        `${table}: NO ROW for ${id} (check the id). Tombstone written anyway so the bridge cannot ` +
          `re-mirror it; media deleted if it existed, ${edge}`,
      );
    } else if (Item["removed"] === true) {
      console.log(`${table}: ${id} was already a tombstone; rewritten with reason "${reason}", media deleted if it existed, ${edge}`);
    } else {
      console.log(`${table}: replaced row with tombstone (was on ${String(Item["channelId"])}), media deleted, ${edge}`);
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
