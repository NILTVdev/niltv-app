#!/usr/bin/env node
/**
 * sync-featured-rails: copy the site's curated shelves into the app.
 *
 * Run this before EVERY OTA publish (eas update) so the app's curated rails
 * match the site: webapp/scripts/build-sections.py bakes the shelves (ids +
 * captions) into the site's pages, and this script reads two built pages:
 *
 *   webapp/featured/index.html -> src/lib/featuredRails.generated.json
 *     (the Featured tab's curated rails, lib/featuredRails.ts)
 *   webapp/index.html          -> src/lib/categoryRails.generated.json
 *     (the homepage's Timeless Category rails, lib/categoryRails.ts; only the
 *     shelves inside the theme-cat-* slots, never Trending or Sponsored)
 *
 *   node scripts/sync-featured-rails.mjs                         # ../../webapp/...
 *   node scripts/sync-featured-rails.mjs <featured> <homepage>   # other built pages
 *
 * Read the pages from a checkout at origin/main (what niltv.com ships), not a
 * stale local branch. The "New This Week" / "Latest on the Network" shelf is
 * skipped on purpose: the app builds that one live off /v1/home
 * (lib/newThisWeek.ts). Node only, no deps.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const mobileRoot = resolve(here, "..");
const source = resolve(process.argv[2] ?? resolve(mobileRoot, "../../webapp/featured/index.html"));
const target = resolve(mobileRoot, "src/lib/featuredRails.generated.json");
const homeSource = resolve(process.argv[3] ?? resolve(mobileRoot, "../../webapp/index.html"));
const homeTarget = resolve(mobileRoot, "src/lib/categoryRails.generated.json");

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

// Homepage category rails: only what sits between the first theme-cat-*
// slot and the end of the last one. A category the site hides (under its
// eight-clip floor) has an empty slot and so no shelf here either.
const home = readFileSync(homeSource, "utf8");
const catStart = home.indexOf("<!-- AUTORAIL:theme-cat-");
const catLast = home.lastIndexOf("<!-- /AUTORAIL:theme-cat-");
if (catStart < 0 || catLast < 0) {
  console.error(`sync-featured-rails: no theme-cat-* slots in ${homeSource}`);
  process.exit(1);
}
const categories = parseShelves(home.slice(catStart, home.indexOf("-->", catLast) + 3)).filter(
  (r) => r.cards.length > 0,
);
if (categories.length === 0) {
  console.error(`sync-featured-rails: no category shelves found in ${homeSource}`);
  process.exit(1);
}
writeFileSync(
  homeTarget,
  JSON.stringify({ syncedFrom: "webapp/index.html", rails: categories }, null, 2) + "\n",
);
for (const r of categories) console.log(`${r.title}: ${r.cards.length} cards (category)`);
console.log(`wrote ${homeTarget}`);
