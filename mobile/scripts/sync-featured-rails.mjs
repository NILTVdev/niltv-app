#!/usr/bin/env node
/**
 * sync-featured-rails: copy the site's curated Featured shelves into the app.
 *
 * Run this before EVERY OTA publish (eas update) so the Featured tab's curated
 * rails match the site: webapp/scripts/build-sections.py bakes the shelves
 * (ids + captions) into webapp/featured/index.html at each web deploy, and
 * this script reads that built page and writes
 * src/lib/featuredRails.generated.json for lib/featuredRails.ts to import.
 *
 *   node scripts/sync-featured-rails.mjs            # ../../webapp/featured/index.html
 *   node scripts/sync-featured-rails.mjs <path>     # another built page
 *
 * The "New This Week" / "Latest on the Network" shelf is skipped on purpose:
 * the app builds that one live off /v1/home (lib/newThisWeek.ts). Node only,
 * no deps.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const mobileRoot = resolve(here, "..");
const source = resolve(process.argv[2] ?? resolve(mobileRoot, "../../webapp/featured/index.html"));
const target = resolve(mobileRoot, "src/lib/featuredRails.generated.json");

/** Shelves the app renders live instead of copying. */
const LIVE_SHELVES = new Set(["New This Week", "Latest on the Network"]);

const NAMED = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  copy: "©",
};

function decode(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, body) => {
    if (body[0] === "#") {
      const code = body[1].toLowerCase() === "x" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return NAMED[body] ?? m;
  });
}

function parseShelves(html) {
  const rails = [];
  const shelfRe = /<h2 class="shelf-title[^"]*">([^<]*)<\/h2>/g;
  const heads = [];
  for (let m; (m = shelfRe.exec(html)); ) heads.push({ title: decode(m[1].trim()), at: m.index + m[0].length });
  heads.forEach((head, i) => {
    const end = i + 1 < heads.length ? heads[i + 1].at : html.length;
    const body = html.slice(head.at, end);
    // One cell at a time (<div class="reel-cell"> ... </div>), so a cell
    // missing its caption or link fails loudly instead of shifting every
    // later id onto the wrong caption.
    const cellRe = /<div class="reel-cell">([\s\S]*?)<\/div>/g; // a cell holds no nested div
    const cards = [];
    const seen = new Set();
    for (let m; (m = cellRe.exec(body)); ) {
      const cell = m[1];
      const id = /href="\/watch\/([^/"]+)\/"/.exec(cell)?.[1];
      const cap = /<p class="reel-caption">([\s\S]*?)<\/p>/.exec(cell)?.[1];
      if (!id || cap === undefined) {
        console.error(`sync-featured-rails: half cell in "${head.title}" (id=${id ?? "?"}, caption=${cap === undefined ? "missing" : "ok"})`);
        process.exit(1);
      }
      if (seen.has(id)) continue;
      seen.add(id);
      cards.push({ id, title: decode(cap.replace(/\s+/g, " ").trim()) });
    }
    rails.push({ title: head.title, cards });
  });
  return rails;
}

const html = readFileSync(source, "utf8");
const all = parseShelves(html);
const rails = all.filter((r) => !LIVE_SHELVES.has(r.title) && r.cards.length > 0);
if (rails.length === 0) {
  console.error(`sync-featured-rails: no curated shelves found in ${source}`);
  process.exit(1);
}
const out = {
  // No timestamp: an unchanged sync must not produce a diff.
  syncedFrom: "webapp/featured/index.html",
  rails,
};
writeFileSync(target, JSON.stringify(out, null, 2) + "\n");
for (const r of all) {
  const note = LIVE_SHELVES.has(r.title) ? " (live in app, skipped)" : "";
  console.log(`${r.title}: ${r.cards.length} cards${note}`);
}
console.log(`wrote ${target}`);
