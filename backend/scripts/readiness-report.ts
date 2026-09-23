/**
 * Readiness report (content foundation): how much of the library each
 * surface can show, and why the rest cannot. The gate before any partner
 * key goes out.
 *
 *   npx tsx scripts/readiness-report.ts --stage dev [--partner p-example] [--csv out.csv]
 */
import { writeFileSync } from "node:fs";
import { GetCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { Partner } from "@niltv/types";
import { getDocClient, partnerKey } from "../src/lib/db";
import { qcFor } from "../src/lib/enrich";
import type { Item } from "../src/lib/shape";
import { isSyndicable } from "../src/lib/syndication";

const args = process.argv.slice(2);
const opt = (n: string) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : undefined);
const stage = opt("stage") ?? "dev";
const table = `niltv-${stage}`;
process.env.TABLE_NAME = table;
const db = getDocClient();

async function main(): Promise<void> {
  const rows: Item[] = [];
  let key: Record<string, unknown> | undefined;
  do {
    const out = await db.send(new ScanCommand({ TableName: table, FilterExpression: "begins_with(PK, :c) AND SK = :m AND attribute_not_exists(removed) AND transcodeStatus = :p", ExpressionAttributeValues: { ":c": "CONTENT#", ":m": "META", ":p": "published" }, ExclusiveStartKey: key }));
    rows.push(...((out.Items ?? []) as Item[]));
    key = out.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (key);

  const partnerId = opt("partner");
  const partner = partnerId ? Partner.safeParse((await db.send(new GetCommand({ TableName: table, Key: partnerKey(partnerId) }))).Item) : undefined;
  const now = new Date();
  const surface = { app: {} as Record<string, number>, site: {} as Record<string, number>, partners: {} as Record<string, number> };
  const reasons: Record<string, number> = {};
  let partnerReady = 0;
  const partnerReasons: Record<string, number> = {};
  const lines = ["id,channel,sport,contentType,athleteId,app,site,partners,reasons"];
  for (const r of rows) {
    const qc = (r["qc"] as { app: string; site: string; partners: string; reasons: string[] } | undefined) ?? qcFor(r, { now });
    surface.app[qc.app] = (surface.app[qc.app] ?? 0) + 1;
    surface.site[qc.site] = (surface.site[qc.site] ?? 0) + 1;
    surface.partners[qc.partners] = (surface.partners[qc.partners] ?? 0) + 1;
    for (const x of qc.reasons) reasons[x] = (reasons[x] ?? 0) + 1;
    if (partner?.success) {
      const v = isSyndicable(r, undefined, partner.data, now);
      if (v.eligible) partnerReady += 1;
      else for (const x of v.reasons) partnerReasons[x] = (partnerReasons[x] ?? 0) + 1;
    }
    lines.push([r["id"], r["channelId"], r["sport"] ?? "", r["contentType"] ?? "", r["athleteId"] ?? "", qc.app, qc.site, qc.partners, `"${qc.reasons.join("; ")}"`].join(","));
  }
  const pct = (n: number) => `${((100 * n) / rows.length).toFixed(1)}%`;
  console.log(JSON.stringify({
    stage, published: rows.length,
    app: surface.app, site: surface.site, partners: surface.partners,
    partnersReadyPct: pct(surface.partners["ready"] ?? 0),
    topReasons: Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 12),
    ...(partner?.success ? { partner: partnerId, partnerReady, partnerReadyPct: pct(partnerReady), partnerReasons: Object.entries(partnerReasons).sort((a, b) => b[1] - a[1]).slice(0, 10) } : {}),
  }, null, 2));
  if (opt("csv")) { writeFileSync(opt("csv")!, lines.join("\n")); console.log(`wrote ${opt("csv")}`); }
}

main().catch((e) => { console.error(e); process.exit(1); });
