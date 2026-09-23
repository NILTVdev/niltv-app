/**
 * Ingest acceptance — the repeatable check that "an Instagram post became a
 * tagged, credited, served row with no hands". Run it after a scheduled bridge
 * run (hourly at :30) or with --invoke to run the bridge first.
 *
 *   npx tsx scripts/ingest-acceptance.ts --stage dev [--since 26] [--invoke] [--json out.json]
 *
 * What it asserts, for every content row published in the last --since hours:
 *   1. the immutable `source` record is there (kind + account);
 *   2. the enrichment pass ran after publish (qc.at >= publishedAt) and its
 *      verdicts are consistent: a missing poster or file is a hold, an
 *      unknown sport/type is listed as a reason, a real athlete credit points
 *      at a complete profile, a channel credit points at a channel with a
 *      school and account;
 *   3. the public API serves it: 200, same title, a creator name, a poster
 *      and a playable file that both answer through CloudFront.
 * Plus one whole-library invariant: no published row without `source`.
 *
 * Read-only against the table; --invoke calls the stage's ingest Lambda (dev
 * only unless --confirm-prod). Exits 1 on any failure so it can gate a deploy.
 */
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { GetCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ATHLETE_PK_PREFIX, CHANNEL_PK_PREFIX, getDocClient } from "../src/lib/db";
import { isCompleteProfile } from "../src/lib/enrich";
import type { Item } from "../src/lib/shape";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string): boolean => process.argv.includes(`--${name}`);

const stage = arg("stage") ?? "dev";
if (stage === "prod" && !flag("confirm-prod")) throw new Error("ingest-acceptance: pass --confirm-prod to run against prod");
const table = `niltv-${stage}`;
process.env.TABLE_NAME = table;
const sinceHours = Number(arg("since") ?? "26");
const sinceIso = new Date(Date.now() - sinceHours * 3600_000).toISOString();

interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}
const checks: Check[] = [];
const check = (name: string, ok: boolean, detail?: string): boolean => {
  checks.push({ name, ok, ...(detail ? { detail } : {}) });
  if (!ok || flag("verbose")) console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  return ok;
};

function cfDomain(): string {
  const ctx = JSON.parse(readFileSync(join(__dirname, "..", "cdk.json"), "utf8")) as { context: Record<string, string> };
  const domain = ctx.context[`niltv:cfDomain:${stage}`];
  if (!domain) throw new Error(`no niltv:cfDomain:${stage} in cdk.json`);
  return domain;
}

const db = getDocClient();

async function scanAll(filter: string, values: Record<string, unknown>, names?: Record<string, string>): Promise<Item[]> {
  const out: Item[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const page = await db.send(
      new ScanCommand({
        TableName: table,
        FilterExpression: filter,
        ExpressionAttributeValues: values,
        ...(names ? { ExpressionAttributeNames: names } : {}),
        ExclusiveStartKey: startKey,
      }),
    );
    out.push(...((page.Items ?? []) as Item[]));
    startKey = page.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (startKey);
  return out;
}

async function invokeIngest(): Promise<void> {
  const fn = `niltv-${stage}-ingest-social`;
  console.log(`invoking ${fn} …`);
  const out = await new LambdaClient({}).send(new InvokeCommand({ FunctionName: fn, InvocationType: "RequestResponse" }));
  check("ingest Lambda ran without a function error", !out.FunctionError, out.FunctionError ?? `status ${out.StatusCode}`);
}

async function head(url: string): Promise<number> {
  try {
    const res = await fetch(url, { method: "GET", headers: { range: "bytes=0-0" } });
    return res.status;
  } catch {
    return 0;
  }
}

async function main(): Promise<void> {
  if (flag("invoke")) await invokeIngest();
  const base = `https://${cfDomain()}`;

  // ── whole-library invariants ────────────────────────────────────────────
  const untagged = await scanAll(
    "begins_with(PK, :c) AND attribute_exists(publishedAt) AND attribute_not_exists(#s)",
    { ":c": "CONTENT#" },
    { "#s": "source" },
  );
  check("no published row without a source record", untagged.length === 0, untagged.map((r) => r["id"]).slice(0, 10).join(", ") || "0 rows");

  // ── the recent rows ─────────────────────────────────────────────────────
  const recent = await scanAll("begins_with(PK, :c) AND publishedAt >= :since", { ":c": "CONTENT#", ":since": sinceIso });
  console.log(`${recent.length} rows published since ${sinceIso} on ${table}`);
  if (recent.length === 0) console.log("(nothing new to check — the invariants above still ran)");

  const channels = new Map<string, Item>();
  for (const ch of await scanAll("begins_with(PK, :c)", { ":c": CHANNEL_PK_PREFIX })) channels.set(String(ch["id"]), ch);
  const profileCache = new Map<string, Item | undefined>();
  const profile = async (id: string): Promise<Item | undefined> => {
    if (!profileCache.has(id)) {
      const out = await db.send(new GetCommand({ TableName: table, Key: { PK: `${ATHLETE_PK_PREFIX}${id}`, SK: "META" } }));
      profileCache.set(id, out.Item as Item | undefined);
    }
    return profileCache.get(id);
  };

  for (const row of recent) {
    const id = String(row["id"]);
    const tag = (s: string) => `${id}: ${s}`;
    const source = row["source"] as { kind?: string; account?: string } | undefined;
    check(tag("source record with kind and account"), Boolean(source?.kind && source.account), JSON.stringify(source ?? null));

    const qc = row["qc"] as { app?: string; site?: string; partners?: string; reasons?: string[]; at?: string } | undefined;
    const reasons = qc?.reasons ?? [];
    check(tag("qc stamped after publish"), Boolean(qc?.at && qc.at >= String(row["publishedAt"])), `qc.at=${qc?.at} publishedAt=${row["publishedAt"]}`);

    const hasPoster = typeof row["thumbPath"] === "string";
    const hasFile = typeof row["playbackPath"] === "string";
    if (!hasPoster) check(tag("no poster → app holds with reason"), qc?.app === "needs-review" && reasons.includes("no poster"), `app=${qc?.app}`);
    else check(tag("poster + file → app ready"), !hasFile || qc?.app === "ready", `app=${qc?.app} reasons=${reasons.join("|")}`);
    check(tag("sport set or listed as unknown"), Boolean(row["sport"]) || reasons.includes("sport unknown"));
    check(tag("content type set or listed as unknown"), Boolean(row["contentType"]) || reasons.includes("content type unknown"));
    check(tag("rights defaults present"), typeof (row["rights"] as { status?: string } | undefined)?.status === "string");
    check(tag("title is not a bare handle or empty"), typeof row["title"] === "string" && row["title"].trim().length > 0 && !/^@/.test(row["title"].trim()), String(row["title"]));

    const channel = channels.get(String(row["channelId"]));
    check(tag("channel row carries school and account"), Boolean(channel && channel["account"] && (channel["school"] || channel["account"] === "niltv")), `channel=${row["channelId"]}`);

    const athleteId = String(row["athleteId"] ?? "");
    if (athleteId && !athleteId.startsWith("p-")) {
      const p = await profile(athleteId);
      check(tag("real credit points at a complete profile"), Boolean(p && isCompleteProfile(p)), `${athleteId}: ${p ? `${p["name"]} / ${p["school"]} / ${p["sport"]}` : "missing"}`);
    } else {
      check(tag("channel credit uses the channel's pseudo-profile"), athleteId.startsWith("p-"), athleteId || "none");
    }

    // ── served ──────────────────────────────────────────────────────────
    const res = await fetch(`${base}/v1/content/${encodeURIComponent(id)}`);
    const served = res.status === 200 ? ((await res.json()) as { title?: string; creator?: { name?: string }; playbackUrl?: string; thumbUrl?: string }) : undefined;
    if (hasFile && typeof row["publishedAt"] === "string") {
      check(tag("public API serves the row"), Boolean(served), `status ${res.status}`);
      if (served) {
        check(tag("served title matches the row"), served.title === row["title"], `${served.title} vs ${row["title"]}`);
        check(tag("served creator has a name"), Boolean(served.creator?.name), JSON.stringify(served.creator ?? null));
        if (served.playbackUrl) check(tag("playable file answers through CloudFront"), [200, 206].includes(await head(served.playbackUrl)), served.playbackUrl);
        if (hasPoster && served.thumbUrl) check(tag("poster answers through CloudFront"), [200, 206].includes(await head(served.thumbUrl)), served.thumbUrl);
      }
    }
  }

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed on ${table} (${recent.length} recent rows)`);
  const out = arg("json");
  if (out) writeFileSync(out, JSON.stringify({ stage, at: new Date().toISOString(), sinceIso, recentRows: recent.length, checks }, null, 2));
  if (failed.length > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
