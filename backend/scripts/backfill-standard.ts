/**
 * Bring the existing library up to the content-foundation standard.
 *
 *   npx tsx scripts/backfill-standard.ts --stage dev            # dry run: report only
 *   npx tsx scripts/backfill-standard.ts --stage dev --apply    # write
 *   options: --roster            sync Profile rows from the dashboard first
 *            --sheet <roster.csv> fill school/sport on profiles by name from the roster sheet
 *            --taxonomy <csv>    apply the content taxonomy sheet as human overrides
 *            --llm               ask Claude about clips the rules were not sure of (needs ANTHROPIC_API_KEY)
 *            --limit N           only the first N content rows (testing)
 *            --report <path>     write the JSON report here
 *
 * What it does to each published row, in order:
 *   1. Writes the immutable `source` record if the row has none — from the
 *      fields the bridge already stored, with today's description as the raw
 *      caption. This is the one write that must precede any human editing.
 *   2. Stamps the channel's school and account on the channel row.
 *   3. Runs the enrichment pass (title, description, athlete credit, school,
 *      sport, content type, rights defaults, marks policy, QC).
 *   4. Optionally asks Claude about low-confidence clips and merges verdicts.
 *   5. Applies the taxonomy sheet as overrides, after measuring how often the
 *      automatic verdicts agreed with it — that number is the accuracy the
 *      future pipeline can be trusted to.
 *   6. Re-stamps the syndication index and reports per-surface readiness.
 *
 * Files, ids, watch URLs and publish state are never touched. Refuses prod
 * without --confirm-prod. Dry run by default.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { GetCommand, PutCommand, ScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ContentType, Sport } from "@niltv/types";
import { channelKey, getDocClient, schoolPolicyKey } from "../src/lib/db";
import { type EnrichContext, applyEnrichment, profilesByHandle, type SchoolPolicy } from "../src/lib/enrich";
import { withMembershipStamp } from "../src/lib/syndication-index";
import { classifyWithClaude, llmAvailable } from "../src/lib/enrich-llm";
import { allProfiles, dashboardApiKey, fetchRoster, importRoster } from "../src/lib/roster";
import type { Item } from "../src/lib/shape";
import { syndicationIndexKeys } from "../src/lib/syndication";
import { ACCOUNT_SCHOOLS, OWN_ACCOUNT_ALIASES } from "../src/handlers/ingest/ingest-social";

const args = process.argv.slice(2);
const opt = (name: string): string | undefined => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : undefined);
const flag = (name: string): boolean => args.includes(`--${name}`);
const stage = opt("stage");
if (stage !== "dev" && stage !== "prod") throw new Error("usage: --stage dev|prod");
if (stage === "prod" && !flag("confirm-prod")) throw new Error("prod backfill rewrites content rows: pass --confirm-prod");
const APPLY = flag("apply");
const table = `niltv-${stage}`;
process.env.TABLE_NAME = table;
const db = getDocClient();
const limit = opt("limit") ? Number(opt("limit")) : undefined;

const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);

async function scanContent(): Promise<Item[]> {
  const rows: Item[] = [];
  let key: Record<string, unknown> | undefined;
  do {
    const out = await db.send(
      new ScanCommand({
        TableName: table,
        FilterExpression: "begins_with(PK, :c) AND SK = :m AND attribute_not_exists(removed)",
        ExpressionAttributeValues: { ":c": "CONTENT#", ":m": "META" },
        ExclusiveStartKey: key,
      }),
    );
    rows.push(...((out.Items ?? []) as Item[]));
    key = out.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (key);
  return rows;
}

async function scanChannels(): Promise<Map<string, Item>> {
  // Paginated: a Scan filter runs per 1 MB page, so a single call over a
  // table this size silently misses channels.
  const items: Item[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const out = await db.send(
      new ScanCommand({
        TableName: table,
        FilterExpression: "begins_with(PK, :c) AND SK = :m",
        ExpressionAttributeValues: { ":c": "CHANNEL#", ":m": "META" },
        ExclusiveStartKey: startKey,
      }),
    );
    items.push(...((out.Items ?? []) as Item[]));
    startKey = out.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (startKey);
  return new Map(items.map((c) => [String(c["id"]), c]));
}

/** The immutable source record, reconstructed from what the bridge stored. Only when absent. */
function sourceFromLegacy(row: Item, channel: Item | undefined): Item {
  const account = str(channel?.["account"]) ?? String(row["channelId"] ?? "").replace(/^ch-/, "");
  const author = str(row["sourceAuthor"])?.toLowerCase().replace(/^@/, "");
  const isCollab = Boolean(author && author !== account);
  const platform = str(row["sourcePlatform"]);
  const kind = platform === "instagram" ? (isCollab ? "instagram-collab" : "instagram-owned") : str(row["playbackPath"])?.endsWith(".m3u8") ? "upload" : "archive";
  return {
    kind,
    account,
    ...(author ? { authorHandle: author } : {}),
    ...(str(row["sourcePostId"]) ? { postId: row["sourcePostId"] } : {}),
    ...(str(row["sourceUrl"]) ? { url: row["sourceUrl"] } : {}),
    ...(str(row["sourcePostedAt"]) ?? str(row["publishedAt"]) ? { postedAt: str(row["sourcePostedAt"]) ?? row["publishedAt"] } : {}),
    // The bridge stored the raw caption as the description. Keep it here, verbatim, forever.
    caption: str(row["description"]) ?? str(row["title"]) ?? "",
    mediaType: "VIDEO",
  };
}

interface TaxonomyRow { content_id: string; sport: string; type_primary: string; type_2: string; type_3: string }
function loadTaxonomy(path: string): Map<string, TaxonomyRow> {
  const lines = readFileSync(path, "utf8").replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim());
  const header = lines[0]!.split(",");
  const idx = (name: string) => header.indexOf(name);
  const map = new Map<string, TaxonomyRow>();
  for (const line of lines.slice(1)) {
    // Titles can contain commas; the classification columns are the last four.
    const cells = line.split(",");
    const tail = cells.slice(-4);
    const id = cells[idx("content_id")] ?? "";
    if (!id) continue;
    map.set(id, { content_id: id, sport: tail[0] ?? "", type_primary: tail[1] ?? "", type_2: tail[2] ?? "", type_3: tail[3] ?? "" });
  }
  return map;
}

/** Roster sheet (NAME, SCHOOL, SPORT, YEAR…) → school/sport on profiles matched by normalized name. */
function applySheetToProfiles(path: string, profiles: Item[]): { matched: number; unmatched: string[] } {
  const lines = readFileSync(path, "utf8").replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim());
  const header = lines[0]!.split(",").map((h) => h.trim().toUpperCase());
  const col = (name: string) => header.findIndex((h) => h.startsWith(name));
  const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z ]/g, "").replace(/\s+/g, " ").trim();
  const byName = new Map(profiles.map((p) => [norm(String(p["name"] ?? "")), p]));
  let matched = 0;
  const unmatched: string[] = [];
  for (const line of lines.slice(1)) {
    const cells = line.split(",");
    const name = cells[col("NAME")]?.trim() ?? "";
    if (!name) continue;
    const p = byName.get(norm(name));
    if (!p) {
      unmatched.push(name);
      continue;
    }
    if (!str(p["school"])) p["school"] = cells[col("SCHOOL")]?.trim() ?? "";
    if (!str(p["sport"])) p["sport"] = cells[col("SPORT")]?.trim() ?? "";
    if (!str(p["year"])) p["year"] = cells[col("YEAR")]?.trim() ?? "";
    p["rosterSheetMatched"] = true;
    matched += 1;
  }
  return { matched, unmatched };
}

async function main(): Promise<void> {
  console.log(`backfill-standard: stage=${stage} ${APPLY ? "APPLY" : "dry run"}`);
  const report: Record<string, unknown> = { stage, apply: APPLY, at: new Date().toISOString() };

  // ── 0. roster ───────────────────────────────────────────────────────────
  if (flag("roster")) {
    const key = await dashboardApiKey(`/niltv/${stage}/dashboard-api-key`);
    const ambassadors = await fetchRoster("https://api.niltv.com", key);
    if (APPLY) {
      const r = await importRoster(table, ambassadors);
      report["roster"] = { fetched: ambassadors.length, ...r };
      console.log(`roster: ${ambassadors.length} fetched → ${r.created} created, ${r.updated} updated, ${r.skipped} skipped`);
    } else {
      report["roster"] = { fetched: ambassadors.length, withHandle: ambassadors.filter((a) => a.ig_username).length };
      console.log(`roster (dry): ${ambassadors.length} ambassadors, ${ambassadors.filter((a) => a.ig_username).length} with a handle`);
    }
  }
  let profiles = await allProfiles(table);
  const sheet = opt("sheet");
  if (sheet) {
    const real = profiles.filter((p) => !String(p["id"]).startsWith("p-"));
    const r = applySheetToProfiles(sheet, real);
    report["sheet"] = { matched: r.matched, unmatched: r.unmatched.length, unmatchedSample: r.unmatched.slice(0, 15) };
    console.log(`sheet: ${r.matched} profiles matched by name, ${r.unmatched.length} sheet rows unmatched`);
    if (APPLY) for (const p of real.filter((x) => x["rosterSheetMatched"] === true)) await db.send(new PutCommand({ TableName: table, Item: p }));
  }
  profiles = profiles.filter((p) => !String(p["id"]).startsWith("p-"));
  const byHandle = profilesByHandle(profiles);

  // ── policy + channels ───────────────────────────────────────────────────
  const { Item: policyRow } = await db.send(new GetCommand({ TableName: table, Key: schoolPolicyKey() }));
  const policy: SchoolPolicy = { blockedSchools: Array.isArray(policyRow?.["blockedSchools"]) ? (policyRow!["blockedSchools"] as string[]) : [] };
  if (APPLY && (!policyRow || !Array.isArray(policyRow["blockedSchools"]))) {
    await db.send(new PutCommand({ TableName: table, Item: { ...schoolPolicyKey(), ...(policyRow ?? {}), blockedSchools: policy.blockedSchools, updatedAt: new Date().toISOString() } }));
  }
  const channels = await scanChannels();
  for (const [id, channel] of channels) {
    const account = str(channel["account"]) ?? id.replace(/^ch-/, "");
    const school = ACCOUNT_SCHOOLS[account];
    if ((school && channel["school"] !== school) || channel["account"] !== account) {
      channel["account"] = account;
      if (school) channel["school"] = school;
      if (APPLY) await db.send(new PutCommand({ TableName: table, Item: channel }));
    }
  }
  const ownAccounts = new Set<string>([...[...channels.values()].map((c) => String(c["account"] ?? "")).filter(Boolean), ...OWN_ACCOUNT_ALIASES]);
  const ignoreHandles = new Set<string>(Array.isArray(policyRow?.["ignoreHandles"]) ? (policyRow!["ignoreHandles"] as string[]).map((h) => h.toLowerCase()) : []);

  // ── content ─────────────────────────────────────────────────────────────
  let rows = (await scanContent()).filter((r) => r["transcodeStatus"] === "published");
  if (limit) rows = rows.slice(0, limit);
  console.log(`content: ${rows.length} published rows`);
  const taxonomy = opt("taxonomy") ? loadTaxonomy(opt("taxonomy")!) : undefined;

  const enriched: Item[] = [];
  const titleSamples: { id: string; before: string; after: string }[] = [];
  let sourcesWritten = 0;
  for (const row of rows) {
    const channel = channels.get(String(row["channelId"]));
    const next: Item = { ...row };
    if (!next["source"]) {
      next["source"] = sourceFromLegacy(row, channel);
      sourcesWritten += 1;
    }
    const account = str((next["source"] as Item)["account"]) ?? "";
    const ctx: EnrichContext = {
      profilesByHandle: byHandle,
      ownAccounts,
      ignoreHandles,
      channelName: str(channel?.["name"]) ?? account,
      ...(ACCOUNT_SCHOOLS[account] ? { accountSchool: ACCOUNT_SCHOOLS[account] } : {}),
      schoolPolicy: policy,
    };
    const out = applyEnrichment(next, ctx);
    if (out["title"] !== row["title"] && titleSamples.length < 250) titleSamples.push({ id: String(row["id"]), before: String(row["title"]), after: String(out["title"]) });
    enriched.push(out);
  }

  // ── LLM second opinion ─────────────────────────────────────────────────
  let llmCount = 0;
  if (flag("llm")) {
    if (!llmAvailable()) throw new Error("--llm needs ANTHROPIC_API_KEY in the environment");
    const unsure = enriched.filter((r) => (Number(r["contentTypeConfidence"] ?? 0) < 0.9 || !r["sport"]) && !(Array.isArray(r["overrides"]) && (r["overrides"] as string[]).includes("contentType")));
    for (let i = 0; i < unsure.length; i += 20) {
      const batch = unsure.slice(i, i + 20);
      const verdicts = await classifyWithClaude(
        batch.map((r) => ({
          id: String(r["id"]),
          caption: String((r["source"] as Item)["caption"] ?? ""),
          account: str((r["source"] as Item)["account"]),
          school: str(r["school"]),
          athleteSport: str(byHandle.get(String((r["source"] as Item)["authorHandle"] ?? ""))?.["sport"]),
        })),
      );
      for (const r of batch) {
        const v = verdicts.get(String(r["id"]));
        if (!v) continue;
        llmCount += 1;
        const overrides = new Set(Array.isArray(r["overrides"]) ? (r["overrides"] as string[]) : []);
        if (!overrides.has("contentType") && v.confidence > Number(r["contentTypeConfidence"] ?? 0)) {
          r["contentType"] = v.contentType;
          r["contentTypes"] = v.secondary;
          r["contentTypeConfidence"] = v.confidence;
        }
        if (!overrides.has("sport") && !r["sport"] && v.sport) r["sport"] = v.sport;
        if (!overrides.has("sponsor") && !r["sponsor"] && v.sponsor) r["sponsor"] = v.sponsor;
      }
      console.log(`llm: ${Math.min(i + 20, unsure.length)}/${unsure.length}`);
    }
  }
  report["llm"] = { applied: llmCount };

  // ── taxonomy sheet: measure, then override ─────────────────────────────
  if (taxonomy) {
    let seen = 0, sportAgree = 0, sportAuto = 0, typeAgree = 0, typeAuto = 0;
    for (const r of enriched) {
      const t = taxonomy.get(String(r["id"]));
      if (!t) continue;
      seen += 1;
      const sheetSport = Sport.safeParse(t.sport).success ? t.sport : undefined;
      const sheetType = ContentType.safeParse(t.type_primary).success ? t.type_primary : undefined;
      if (sheetSport && r["sport"]) { sportAuto += 1; if (r["sport"] === sheetSport) sportAgree += 1; }
      if (sheetType && r["contentType"]) { typeAuto += 1; if (r["contentType"] === sheetType) typeAgree += 1; }
      const overrides = new Set(Array.isArray(r["overrides"]) ? (r["overrides"] as string[]) : []);
      if (sheetSport) { r["sport"] = sheetSport; overrides.add("sport"); }
      if (sheetType) {
        r["contentType"] = sheetType;
        r["contentTypes"] = [t.type_2, t.type_3].filter((x) => ContentType.safeParse(x).success);
        r["contentTypeConfidence"] = 1;
        overrides.add("contentType");
      }
      r["overrides"] = [...overrides];
    }
    report["taxonomy"] = {
      rowsInSheet: taxonomy.size, matched: seen,
      sport: { automaticVerdicts: sportAuto, agreed: sportAgree, accuracy: sportAuto ? +(sportAgree / sportAuto).toFixed(3) : null },
      contentType: { automaticVerdicts: typeAuto, agreed: typeAgree, accuracy: typeAuto ? +(typeAgree / typeAuto).toFixed(3) : null },
    };
    console.log(`taxonomy: ${seen} matched; sport agreement ${sportAgree}/${sportAuto}, type agreement ${typeAgree}/${typeAuto}`);
  }

  // ── index + write + readiness ──────────────────────────────────────────
  const qc = { app: {} as Record<string, number>, site: {} as Record<string, number>, partners: {} as Record<string, number> };
  const reasons: Record<string, number> = {};
  const unresolved: Record<string, number> = {};
  let credited = 0;
  // Only rows the pass actually changed are written. A full put of an
  // unchanged row can only lose a like or a view counted while this runs.
  const before = new Map(rows.map((r) => [String(r["id"]), r]));
  const fieldChanges: Record<string, number> = {};
  let writes = 0;
  for (const r of enriched) {
    // Re-run QC after LLM/taxonomy changed classification.
    const { qcFor } = await import("../src/lib/enrich");
    r["qc"] = qcFor(r, {});
    // Entering or leaving the index bumps syndicationUpdatedAt so /changes sees it.
    const { row: stamped, keys } = withMembershipStamp(r);
    if (stamped["syndicationUpdatedAt"] !== r["syndicationUpdatedAt"]) r["syndicationUpdatedAt"] = stamped["syndicationUpdatedAt"];
    if (keys) Object.assign(r, keys);
    else { delete r["GSI3PK"]; delete r["GSI3SK"]; }
    const q = r["qc"] as { app: string; site: string; partners: string; reasons: string[] };
    qc.app[q.app] = (qc.app[q.app] ?? 0) + 1;
    qc.site[q.site] = (qc.site[q.site] ?? 0) + 1;
    qc.partners[q.partners] = (qc.partners[q.partners] ?? 0) + 1;
    for (const reason of q.reasons) reasons[reason] = (reasons[reason] ?? 0) + 1;
    for (const h of (r["unresolvedHandles"] as string[] | undefined) ?? []) unresolved[h] = (unresolved[h] ?? 0) + 1;
    if (typeof r["athleteId"] === "string" && !String(r["athleteId"]).startsWith("p-")) credited += 1;
    const original = before.get(String(r["id"])) ?? {};
    const changedFields = diffFields(original, r);
    for (const f of changedFields) fieldChanges[f] = (fieldChanges[f] ?? 0) + 1;
    if (changedFields.length === 0) continue;
    writes += 1;
    if (APPLY) await db.send(updateChanged(String(r["PK"]), String(r["SK"]), r, changedFields));
  }
  const sportCounts: Record<string, number> = {};
  const typeCounts: Record<string, number> = {};
  for (const r of enriched) {
    sportCounts[String(r["sport"] ?? "(none)")] = (sportCounts[String(r["sport"] ?? "(none)")] ?? 0) + 1;
    typeCounts[String(r["contentType"] ?? "(none)")] = (typeCounts[String(r["contentType"] ?? "(none)")] ?? 0) + 1;
  }
  Object.assign(report, {
    rows: enriched.length, rowsChanged: writes, fieldChanges, sourcesWritten, creditedToRealAthlete: credited, profilesRealWithHandle: byHandle.size,
    qc, topReasons: Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 12),
    topUnresolvedHandles: Object.entries(unresolved).sort((a, b) => b[1] - a[1]).slice(0, 25),
    sportCounts, typeCounts, titleSamples,
  });
  const out = opt("report");
  if (out) writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, titleSamples: report["titleSamples"] }, null, 2));
  console.log(APPLY ? `wrote ${writes} of ${enriched.length} rows` : `dry run — nothing written (${writes} of ${enriched.length} rows would change)`);
}

/**
 * Writes only the fields the pass changed, on a row that still exists. Likes,
 * views and anything else counted while the backfill runs are never part of
 * the update, so they cannot be rolled back to the values the scan read.
 */
function updateChanged(pk: string, sk: string, row: Item, fields: string[]): UpdateCommand {
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};
  const sets: string[] = [];
  const removes: string[] = [];
  fields.forEach((field, i) => {
    names[`#f${i}`] = field;
    if (row[field] === undefined) removes.push(`#f${i}`);
    else {
      values[`:v${i}`] = row[field];
      sets.push(`#f${i} = :v${i}`);
    }
  });
  return new UpdateCommand({
    TableName: table,
    Key: { PK: pk, SK: sk },
    ConditionExpression: "attribute_exists(PK)",
    UpdateExpression: [sets.length ? `SET ${sets.join(", ")}` : "", removes.length ? `REMOVE ${removes.join(", ")}` : ""].filter(Boolean).join(" "),
    ExpressionAttributeNames: names,
    ...(sets.length ? { ExpressionAttributeValues: values } : {}),
  });
}

/** Canonical JSON: object keys sorted, so key order never counts as a change. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Top-level fields that differ; the QC stamp time alone is not a change. */
function diffFields(a: Item, b: Item): string[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const out: string[] = [];
  for (const k of keys) {
    let x = a[k];
    let y = b[k];
    if (k === "qc") {
      x = x && typeof x === "object" ? { ...(x as Item), at: undefined } : x;
      y = y && typeof y === "object" ? { ...(y as Item), at: undefined } : y;
    }
    if (canonical(x) !== canonical(y)) out.push(k);
  }
  return out;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
