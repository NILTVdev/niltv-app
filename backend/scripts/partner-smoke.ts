/**
 * Partner content API smoke test — exercises the deployed surface end to end
 * on DEV and cleans up after itself.
 *
 *   npx tsx scripts/partner-smoke.ts --stage dev [--keep]
 *
 * What it does, in order:
 *   1. Picks one published social clip from the table and tags it as
 *      syndicable (owned, marks cleared, no music) in a throwaway series.
 *   2. Writes a throwaway partner (p-smoke-test) with a fresh API key,
 *      hashed with the real pepper — the same rows the admin route writes.
 *   3. Calls /partner/v1/* through CloudFront: no key → 401, bad key → 403,
 *      /me, /series, /content, /content/{id}, an out-of-scope id → 404,
 *      /changes.
 *   4. Downloads the first bytes of the signed MP4, then proves a tampered
 *      signature and a stripped signature both get 403.
 *   5. Withdraws the clip (row write), checks 404 + the tombstone in
 *      /changes, restores it.
 *   6. Invokes the feed builder and fetches the Media RSS + JSON feeds.
 *   7. Removes every row and object it created and restores the clip's
 *      original tagging (unless --keep).
 *
 * Direct table writes stand in for the admin routes so the script needs only
 * AWS credentials, not a staff Cognito session. Refuses to run against prod.
 */
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { DeleteObjectsCommand, ListBucketsCommand, S3Client } from "@aws-sdk/client-s3";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { DeleteCommand, GetCommand, PutCommand, ScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  PARTNERS_ALL_GSI1PK,
  SERIES_ALL_GSI1PK,
  contentKey,
  getDocClient,
  partnerApiKeyKey,
  partnerKey,
  seriesKey,
} from "../src/lib/db";
import { generateApiKey, hashApiKey, keyPrefixOf, randomToken } from "../src/lib/partner-keys";
import type { Item } from "../src/lib/shape";
import { syndicationIndexKeys } from "../src/lib/syndication";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
const KEEP = process.argv.includes("--keep");

const stage = arg("stage") ?? "dev";
if (stage === "prod") throw new Error("partner-smoke: refuses to run against prod");
const table = `niltv-${stage}`;
process.env.TABLE_NAME = table;

const SERIES_ID = "smoke-series";
const PARTNER_ID = "p-smoke-test";

interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}
const checks: Check[] = [];
const check = (name: string, ok: boolean, detail?: string) => {
  checks.push({ name, ok, ...(detail ? { detail } : {}) });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};

async function cfDomain(): Promise<string> {
  const ctx = JSON.parse(readFileSync(join(__dirname, "..", "cdk.json"), "utf8")) as { context: Record<string, string> };
  const domain = ctx.context[`niltv:cfDomain:${stage}`];
  if (!domain) throw new Error(`no niltv:cfDomain:${stage} in cdk.json`);
  return domain;
}

async function videoBucket(): Promise<string> {
  const { Buckets } = await new S3Client({}).send(new ListBucketsCommand({}));
  const hit = (Buckets ?? []).map((b) => b.Name ?? "").find((n) => n.startsWith(`niltv-${stage}-video-hls-`));
  if (!hit) throw new Error("video bucket not found");
  return hit;
}

async function pepper(): Promise<string> {
  const out = await new SecretsManagerClient({}).send(new GetSecretValueCommand({ SecretId: `niltv-${stage}-partner-key-pepper` }));
  if (!out.SecretString) throw new Error("pepper secret is empty");
  return out.SecretString;
}

async function ssm(name: string): Promise<string | undefined> {
  try {
    const out = await new SSMClient({}).send(new GetParameterCommand({ Name: name }));
    return out.Parameter?.Value;
  } catch {
    return undefined;
  }
}

/** One published social clip with a stored MP4 — the kind the ingest writes. */
async function pickClip(): Promise<Item> {
  const db = getDocClient();
  let startKey: Record<string, unknown> | undefined;
  do {
    const out = await db.send(
      new ScanCommand({
        TableName: table,
        FilterExpression: "begins_with(PK, :c) AND transcodeStatus = :p AND attribute_not_exists(withdrawnAt)",
        ExpressionAttributeValues: { ":c": "CONTENT#", ":p": "published" },
        ExclusiveStartKey: startKey,
      }),
    );
    const hit = ((out.Items ?? []) as Item[]).find(
      (row) => typeof row["playbackPath"] === "string" && row["playbackPath"].endsWith("/master.mp4") && !row["seriesId"],
    );
    if (hit) return hit;
    startKey = out.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (startKey);
  throw new Error("no published social clip with a master.mp4 found");
}

async function http(url: string, init: RequestInit = {}): Promise<{ status: number; body: string; headers: Headers }> {
  const res = await fetch(url, init);
  return { status: res.status, body: await res.text(), headers: res.headers };
}

async function main(): Promise<void> {
  const db = getDocClient();
  const domain = await cfDomain();
  const base = `https://${domain}`;
  const dlDomain = await ssm(`/niltv/${stage}/partner-dl/domain`);
  check("edge published the partner download domain (SSM)", Boolean(dlDomain), dlDomain);

  // ── 1. Tag a clip ──────────────────────────────────────────────────────
  const clip = await pickClip();
  const clipId = String(clip["id"]);
  const original = {
    rights: clip["rights"],
    seriesId: clip["seriesId"],
    syndicationUpdatedAt: clip["syndicationUpdatedAt"],
    GSI3PK: clip["GSI3PK"],
    GSI3SK: clip["GSI3SK"],
  };
  console.log(`using clip ${clipId} ("${String(clip["title"]).slice(0, 50)}")`);

  const now = new Date().toISOString();
  await db.send(
    new PutCommand({
      TableName: table,
      Item: {
        ...seriesKey(SERIES_ID),
        id: SERIES_ID,
        name: "Smoke Series",
        kind: "show",
        syndicationDelayDays: 0,
        createdAt: now,
        GSI1PK: SERIES_ALL_GSI1PK,
        GSI1SK: "Smoke Series",
      },
    }),
  );
  const tagged: Item = {
    ...clip,
    rights: { status: "owned", logoCleared: true, music: "none", territory: ["WW"] },
    seriesId: SERIES_ID,
    syndicationUpdatedAt: now,
  };
  const keys = syndicationIndexKeys(tagged);
  if (!keys) throw new Error("tagged clip did not become an index candidate");
  await db.send(
    new UpdateCommand({
      TableName: table,
      Key: contentKey(clipId),
      UpdateExpression: "SET #rights = :rights, seriesId = :series, syndicationUpdatedAt = :now, GSI3PK = :pk, GSI3SK = :sk",
      ExpressionAttributeNames: { "#rights": "rights" },
      ExpressionAttributeValues: { ":rights": tagged["rights"], ":series": SERIES_ID, ":now": now, ":pk": keys.GSI3PK, ":sk": keys.GSI3SK },
    }),
  );

  // ── 2. Partner + key ───────────────────────────────────────────────────
  const apiKey = generateApiKey(stage);
  const keyHash = hashApiKey(await pepper(), apiKey);
  const feedToken = randomToken(24);
  await db.send(
    new PutCommand({
      TableName: table,
      Item: {
        ...partnerKey(PARTNER_ID),
        id: PARTNER_ID,
        name: "Smoke Test Partner",
        status: "active",
        licence: { seriesIds: [SERIES_ID], channelIds: [], assetTypes: ["episode", "clip", "short"], territory: ["WW"] },
        feedToken,
        webhookEnabled: false,
        ipAllowlist: [],
        categoryMap: { [SERIES_ID]: "College Sports" },
        keyPrefix: keyPrefixOf(apiKey),
        activeKeyHash: keyHash,
        webhookSecret: randomToken(48),
        createdAt: now,
        GSI1PK: PARTNERS_ALL_GSI1PK,
        GSI1SK: "Smoke Test Partner",
      },
    }),
  );
  await db.send(
    new PutCommand({
      TableName: table,
      Item: { ...partnerApiKeyKey(keyHash), partnerId: PARTNER_ID, keyPrefix: keyPrefixOf(apiKey), createdAt: now },
    }),
  );
  const auth = { headers: { "x-api-key": apiKey } };

  try {
    // ── 3. API through CloudFront ────────────────────────────────────────
    const noKey = await http(`${base}/partner/v1/me`);
    check("no key → 401", noKey.status === 401, `got ${noKey.status}`);
    const badKey = await http(`${base}/partner/v1/me`, { headers: { "x-api-key": `nltv_${stage}_${"x".repeat(32)}` } });
    check("unknown key → 403", badKey.status === 403, `got ${badKey.status}`);

    const me = await http(`${base}/partner/v1/me`, auth);
    const meBody = me.status === 200 ? (JSON.parse(me.body) as { partner: { id: string }; feeds?: { mrss: string; json: string } }) : undefined;
    check("/me → 200 with our partner id", meBody?.partner.id === PARTNER_ID, `status ${me.status}`);
    check("/me carries feed URLs", Boolean(meBody?.feeds?.mrss && meBody.feeds.json));

    const series = await http(`${base}/partner/v1/series`, auth);
    check("/series lists the licensed series", series.status === 200 && series.body.includes(`"id":"${SERIES_ID}"`), `status ${series.status}`);

    const list = await http(`${base}/partner/v1/content?limit=20`, auth);
    const listBody = list.status === 200 ? (JSON.parse(list.body) as { items: { id: string; files: { mp4: { url: string } } }[] }) : undefined;
    const listed = listBody?.items.find((i) => i.id === clipId);
    check("/content lists the tagged clip", Boolean(listed), `status ${list.status}, ${listBody?.items.length ?? 0} items`);

    const detail = await http(`${base}/partner/v1/content/${clipId}`, auth);
    const asset = detail.status === 200 ? (JSON.parse(detail.body) as { title: string; files: { mp4: { url: string; expiresAt: string }; poster?: { url: string } }; canonicalUrl: string }) : undefined;
    check("/content/{id} → 200", Boolean(asset), `status ${detail.status}`);
    check("asset has a signed mp4 url on the download domain", Boolean(asset && dlDomain && asset.files.mp4.url.startsWith(`https://${dlDomain}/`)), asset?.files.mp4.url.slice(0, 80));
    check("no secrets leak in the asset", !detail.body.includes("webhookSecret") && !detail.body.includes("activeKeyHash"));

    // an out-of-scope published id: any other published clip
    const other = await db.send(
      new ScanCommand({
        TableName: table,
        FilterExpression: "begins_with(PK, :c) AND transcodeStatus = :p AND id <> :me",
        ExpressionAttributeValues: { ":c": "CONTENT#", ":p": "published", ":me": clipId },
        Limit: 25,
      }),
    );
    const otherId = ((other.Items ?? []) as Item[]).find((r) => typeof r["id"] === "string")?.["id"];
    if (typeof otherId === "string") {
      const oos = await http(`${base}/partner/v1/content/${otherId}`, auth);
      check("out-of-scope id → 404 (not 403)", oos.status === 404, `got ${oos.status}`);
    }

    // ── 4. Signed download ───────────────────────────────────────────────
    if (asset) {
      const range = await http(asset.files.mp4.url, { headers: { Range: "bytes=0-1023" } });
      check("signed mp4 serves a byte range (206/200)", range.status === 206 || range.status === 200, `got ${range.status}`);
      const tampered = asset.files.mp4.url.replace(/Signature=([^&]{10})/, (_m, s: string) => `Signature=${s.split("").reverse().join("")}`);
      const bad = await http(tampered, { method: "HEAD" });
      check("tampered signature → 403", bad.status === 403, `got ${bad.status}`);
      const stripped = asset.files.mp4.url.split("?")[0] ?? "";
      const naked = await http(stripped, { method: "HEAD" });
      check("unsigned download url → 403", naked.status === 403, `got ${naked.status}`);
      if (asset.files.poster) {
        const poster = await http(asset.files.poster.url, { method: "HEAD" });
        check("signed poster → 200", poster.status === 200, `got ${poster.status}`);
      }
    }

    const since = new Date(Date.now() - 3600_000).toISOString();
    const changes = await http(`${base}/partner/v1/changes?since=${encodeURIComponent(since)}`, auth);
    check("/changes lists the clip as published/updated", changes.status === 200 && changes.body.includes(`"id":"${clipId}"`), `status ${changes.status}`);

    // ── 5. Withdraw / restore ────────────────────────────────────────────
    const withdrawnAt = new Date().toISOString();
    await db.send(
      new UpdateCommand({
        TableName: table,
        Key: contentKey(clipId),
        UpdateExpression: "SET withdrawnAt = :w, withdrawnReason = :r, syndicationUpdatedAt = :w, GSI3SK = :sk",
        ExpressionAttributeValues: { ":w": withdrawnAt, ":r": "smoke test", ":sk": `${withdrawnAt}#${clipId}` },
      }),
    );
    const gone = await http(`${base}/partner/v1/content/${clipId}`, auth);
    check("withdrawn clip → 404", gone.status === 404, `got ${gone.status}`);
    const tomb = await http(`${base}/partner/v1/changes?since=${encodeURIComponent(since)}`, auth);
    check("/changes carries the withdrawal tombstone", tomb.status === 200 && tomb.body.includes('"type":"content.withdrawn"'));
    const restoredAt = new Date().toISOString();
    await db.send(
      new UpdateCommand({
        TableName: table,
        Key: contentKey(clipId),
        UpdateExpression: "SET syndicationUpdatedAt = :n, GSI3SK = :sk REMOVE withdrawnAt, withdrawnReason",
        ExpressionAttributeValues: { ":n": restoredAt, ":sk": `${restoredAt}#${clipId}` },
      }),
    );
    const back = await http(`${base}/partner/v1/content/${clipId}`, auth);
    check("restored clip → 200", back.status === 200, `got ${back.status}`);

    // ── 6. Feeds ─────────────────────────────────────────────────────────
    const lambda = new LambdaClient({});
    const invoked = await lambda.send(new InvokeCommand({ FunctionName: `niltv-${stage}-partner-feed-build` }));
    check("feed-build invoked", invoked.StatusCode === 200 && !invoked.FunctionError, invoked.FunctionError);
    if (meBody?.feeds) {
      const mrss = await http(`${meBody.feeds.mrss}?nocache=${Date.now()}`);
      check("MRSS feed serves", mrss.status === 200, `status ${mrss.status}`);
      check("MRSS feed carries the clip with media:content", mrss.body.includes(`<guid isPermaLink="false">${clipId}</guid>`) && mrss.body.includes("<media:content "));
      check("MRSS feed content-type", (mrss.headers.get("content-type") ?? "").includes("rss+xml"), mrss.headers.get("content-type") ?? "");
      const json = await http(`${meBody.feeds.json}?nocache=${Date.now()}`);
      check("JSON feed parses and carries the clip", json.status === 200 && (JSON.parse(json.body) as { items: { id: string }[] }).items.some((i) => i.id === clipId));
    }
  } finally {
    if (KEEP) {
      console.log(`--keep: leaving ${PARTNER_ID}, ${SERIES_ID} and the tagging on ${clipId}. API key: ${apiKey}`);
    } else {
      await db.send(new DeleteCommand({ TableName: table, Key: partnerApiKeyKey(keyHash) }));
      await db.send(new DeleteCommand({ TableName: table, Key: partnerKey(PARTNER_ID) }));
      await db.send(new DeleteCommand({ TableName: table, Key: seriesKey(SERIES_ID) }));
      const sets: string[] = [];
      const removes: string[] = ["withdrawnAt", "withdrawnReason"];
      const values: Record<string, unknown> = {};
      for (const [field, value] of Object.entries(original)) {
        if (value === undefined) removes.push(field === "rights" ? "#rights" : field);
        else {
          sets.push(`${field === "rights" ? "#rights" : field} = :${field}`);
          values[`:${field}`] = value;
        }
      }
      await db.send(
        new UpdateCommand({
          TableName: table,
          Key: contentKey(clipId),
          UpdateExpression: `${sets.length ? `SET ${sets.join(", ")} ` : ""}REMOVE ${removes.join(", ")}`,
          ExpressionAttributeNames: { "#rights": "rights" },
          ...(Object.keys(values).length ? { ExpressionAttributeValues: values } : {}),
        }),
      );
      const bucket = await videoBucket();
      await new S3Client({}).send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: [{ Key: `feeds/${PARTNER_ID}-${feedToken}.xml` }, { Key: `feeds/${PARTNER_ID}-${feedToken}.json` }] },
        }),
      );
      const { Item: after } = await db.send(new GetCommand({ TableName: table, Key: contentKey(clipId) }));
      console.log(`cleanup: restored ${clipId} (rights ${after?.["rights"] ? "kept" : "cleared"}, GSI3 ${after?.["GSI3PK"] ? "kept" : "cleared"})`);
    }
  }

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  if (failed.length > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
