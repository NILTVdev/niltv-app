/**
 * Apply human decisions from a CSV as overrides (content foundation).
 *
 *   npx tsx scripts/import-overrides.ts --stage dev --file tags.csv [--apply]
 *
 * CSV header: id plus any of
 *   title, description, summary, sport, contentType, contentTypes (a|b),
 *   sponsor, school, seriesId, season, episode, tags (a|b),
 *   rights.status, rights.music, rights.logoCleared (true/false),
 *   rights.availableFrom, rights.expiresAt, featuredAthleteIds (a|b)
 * Every field present and non-empty on a row is written AND recorded in
 * `overrides`, so the enrichment pass never recomputes it. Use it to apply
 * tagging decisions and clear the tagging queue in bulk. Dry run by default.
 */
import { readFileSync } from "node:fs";
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ContentRights, ContentType, Sport } from "@niltv/types";
import { contentKey, getDocClient } from "../src/lib/db";
import { qcFor } from "../src/lib/enrich";
import type { Item } from "../src/lib/shape";
import { loadSeriesFor, stampSyndicationIndex } from "../src/lib/syndication-index";

const args = process.argv.slice(2);
const opt = (n: string) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : undefined);
const stage = opt("stage");
if (stage !== "dev" && stage !== "prod") throw new Error("usage: --stage dev|prod --file <csv> [--apply]");
if (stage === "prod" && !args.includes("--confirm-prod")) throw new Error("pass --confirm-prod for prod");
const file = opt("file");
if (!file) throw new Error("--file is required");
const APPLY = args.includes("--apply");
const table = `niltv-${stage}`;
process.env.TABLE_NAME = table;
const db = getDocClient();

function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i += 1; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else if (ch !== "\r") cell += ch;
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  const header = (rows.shift() ?? []).map((h) => h.trim());
  return rows.filter((r) => r.some((c) => c.trim())).map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? "").trim()])));
}

const list = (v: string) => v.split("|").map((s) => s.trim()).filter(Boolean);

async function main(): Promise<void> {
  const rows = parseCsv(readFileSync(file!, "utf8").replace(/^﻿/, ""));
  console.log(`import-overrides: ${rows.length} rows from ${file} (${APPLY ? "APPLY" : "dry run"})`);
  let written = 0, missing = 0, invalid = 0;
  for (const r of rows) {
    const id = r["id"] || r["content_id"];
    if (!id) continue;
    const { Item } = await db.send(new GetCommand({ TableName: table, Key: contentKey(id) }));
    if (!Item) { missing += 1; console.log(`  missing ${id}`); continue; }
    const row = Item as Item;
    const sets: Record<string, unknown> = {};
    const fields: string[] = [];
    const take = (col: string, field: string, value: unknown) => { if (r[col]) { sets[field] = value; fields.push(field); } };
    take("title", "title", r["title"]);
    take("description", "description", r["description"]);
    take("summary", "summary", r["summary"]);
    take("school", "school", r["school"]);
    take("sponsor", "sponsor", r["sponsor"]);
    take("seriesId", "seriesId", r["seriesId"]);
    if (r["season"]) take("season", "season", Number(r["season"]));
    if (r["episode"]) take("episode", "episode", Number(r["episode"]));
    if (r["tags"]) take("tags", "tags", list(r["tags"]));
    if (r["featuredAthleteIds"]) take("featuredAthleteIds", "featuredAthleteIds", list(r["featuredAthleteIds"]));
    if (r["sport"]) {
      if (!Sport.safeParse(r["sport"]).success) { invalid += 1; console.log(`  ${id}: bad sport ${r["sport"]}`); continue; }
      take("sport", "sport", r["sport"]);
    }
    if (r["contentType"]) {
      if (!ContentType.safeParse(r["contentType"]).success) { invalid += 1; console.log(`  ${id}: bad contentType ${r["contentType"]}`); continue; }
      take("contentType", "contentType", r["contentType"]);
      sets["contentTypeConfidence"] = 1;
      if (r["contentTypes"]) sets["contentTypes"] = list(r["contentTypes"]).filter((t) => ContentType.safeParse(t).success);
    }
    const rightsCols = ["rights.status", "rights.music", "rights.logoCleared", "rights.availableFrom", "rights.expiresAt"].filter((c) => r[c]);
    if (rightsCols.length) {
      const rights: Record<string, unknown> = typeof row["rights"] === "object" && row["rights"] ? { ...(row["rights"] as Item) } : {};
      for (const c of rightsCols) {
        const key = c.slice("rights.".length);
        rights[key] = key === "logoCleared" ? /^(true|yes|1)$/i.test(r[c]!) : r[c];
        fields.push(c);
      }
      const parsed = ContentRights.safeParse(rights);
      if (!parsed.success) { invalid += 1; console.log(`  ${id}: bad rights ${parsed.error.issues.map((i) => i.message).join("; ")}`); continue; }
      sets["rights"] = parsed.data;
    }
    if (fields.length === 0) continue;
    const overrides = [...new Set([...(Array.isArray(row["overrides"]) ? (row["overrides"] as string[]) : []), ...fields])];
    const next: Item = { ...row, ...sets, overrides, syndicationUpdatedAt: new Date().toISOString() };
    next["qc"] = qcFor(next, { series: await loadSeriesFor(next) });
    if (APPLY) {
      const names: Record<string, string> = {};
      const values: Record<string, unknown> = {};
      const clauses: string[] = [];
      const all = { ...sets, overrides, syndicationUpdatedAt: next["syndicationUpdatedAt"], qc: next["qc"] };
      let i = 0;
      for (const [k, v] of Object.entries(all)) {
        names[`#f${i}`] = k; values[`:v${i}`] = v; clauses.push(`#f${i} = :v${i}`); i += 1;
      }
      await db.send(new UpdateCommand({ TableName: table, Key: contentKey(id), UpdateExpression: `SET ${clauses.join(", ")}`, ExpressionAttributeNames: names, ExpressionAttributeValues: values }));
      await stampSyndicationIndex(next);
    }
    written += 1;
    console.log(`  ${id}: ${fields.join(", ")}`);
  }
  console.log(`${written} rows ${APPLY ? "written" : "would be written"}, ${missing} missing, ${invalid} invalid`);
}

main().catch((e) => { console.error(e); process.exit(1); });
