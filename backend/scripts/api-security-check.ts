/**
 * API security check — black-box probes against a deployed stage, from the
 * outside, the way an attacker or a partner's integrator would see it. No
 * AWS credentials needed for the core set; a partner key unlocks the
 * authenticated partner probes.
 *
 *   npx tsx scripts/api-security-check.ts --stage dev [--partner-key nltv_dev_…] [--mint] [--json out.json]
 *
 * --mint (dev only, needs AWS credentials) writes a throwaway partner + key
 * the way the admin route would, runs the keyed probes, and deletes it.
 *
 * Groups:
 *   headers   HSTS, nosniff, DENY framing, referrer policy, nothing leaking
 *   cors      allowlisted origin echoed, unknown origin not, preflight sane
 *   public    bad ids / params / bodies answer 4xx with the ApiError shape,
 *             never 5xx, never a stack trace
 *   authed    every JWT route refuses missing and garbage bearers
 *   admin     every admin route refuses missing and garbage bearers
 *   partner   no key 401, unknown key 403, key-in-query ignored, method
 *             shape, param validation, no secret fields in responses
 *   downloads unsigned and tampered signed URLs are refused; feeds need
 *             their token
 *
 * Every probe sends an invalid or unauthenticated request, so nothing is
 * written on the far side. Prod needs --confirm-prod.
 */
import { DeleteCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PARTNERS_ALL_GSI1PK, getDocClient, partnerApiKeyKey, partnerKey } from "../src/lib/db";
import { generateApiKey, hashApiKey, keyPrefixOf, randomToken } from "../src/lib/partner-keys";
import { webOrigins } from "../lib/web-origins";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string): boolean => process.argv.includes(`--${name}`);

const stage = arg("stage") ?? "dev";
if (stage === "prod" && !flag("confirm-prod")) throw new Error("api-security-check: pass --confirm-prod to probe prod");
if (stage === "prod" && flag("mint")) throw new Error("api-security-check: --mint is dev only");
const table = `niltv-${stage}`;
process.env.TABLE_NAME = table;

const ADMIN_BASES: Record<string, string> = {
  dev: "https://wbcz89dvh3.execute-api.us-east-1.amazonaws.com",
  prod: "https://2znyvl6g4f.execute-api.us-east-1.amazonaws.com",
};
const adminBase = process.env.ADMIN_API_URL ?? ADMIN_BASES[stage] ?? "";

interface Check {
  group: string;
  name: string;
  ok: boolean;
  detail?: string;
}
const checks: Check[] = [];
const check = (group: string, name: string, ok: boolean, detail?: string): boolean => {
  checks.push({ group, name, ok, ...(detail ? { detail } : {}) });
  console.log(`${ok ? "PASS" : "FAIL"}  [${group}] ${name}${detail ? `  (${detail})` : ""}`);
  return ok;
};

function cfDomain(): string {
  const ctx = JSON.parse(readFileSync(join(__dirname, "..", "cdk.json"), "utf8")) as { context: Record<string, string> };
  const domain = ctx.context[`niltv:cfDomain:${stage}`];
  if (!domain) throw new Error(`no niltv:cfDomain:${stage} in cdk.json`);
  return domain;
}

interface Res {
  status: number;
  body: string;
  headers: Headers;
}
async function http(url: string, init: RequestInit = {}): Promise<Res> {
  const res = await fetch(url, { redirect: "manual", ...init });
  return { status: res.status, body: await res.text(), headers: res.headers };
}
const jsonHeaders = { "content-type": "application/json" };
const STACK_TRACE = /node_modules|\n\s+at |Traceback|ReferenceError|TypeError:|SyntaxError:/;
const cleanError = (r: Res): boolean => r.status < 500 && !STACK_TRACE.test(r.body);
const apiErrorShape = (r: Res): boolean => {
  try {
    const b = JSON.parse(r.body) as { error?: unknown; message?: unknown };
    return typeof b.error === "string";
  } catch {
    return false;
  }
};

async function ssm(name: string): Promise<string | undefined> {
  try {
    return (await new SSMClient({}).send(new GetParameterCommand({ Name: name }))).Parameter?.Value;
  } catch {
    return undefined;
  }
}

// ── throwaway partner (dev, --mint) ─────────────────────────────────────────
const MINT_ID = `p-secprobe-${randomToken(4).toLowerCase()}`;
async function mint(): Promise<{ key: string; cleanup: () => Promise<void> }> {
  const db = getDocClient();
  const secret = await new SecretsManagerClient({}).send(new GetSecretValueCommand({ SecretId: `niltv-${stage}-partner-key-pepper` }));
  if (!secret.SecretString) throw new Error("pepper secret is empty");
  const key = generateApiKey(stage);
  const hash = hashApiKey(secret.SecretString, key);
  const now = new Date().toISOString();
  await db.send(
    new PutCommand({
      TableName: table,
      Item: {
        ...partnerKey(MINT_ID),
        id: MINT_ID,
        name: "Security probe (throwaway)",
        status: "active",
        licence: { seriesIds: [], channelIds: [], assetTypes: ["clip"], territory: ["WW"] },
        feedToken: randomToken(24),
        webhookEnabled: false,
        ipAllowlist: [],
        categoryMap: {},
        keyPrefix: keyPrefixOf(key),
        activeKeyHash: hash,
        keyHashes: [hash],
        webhookSecret: randomToken(48),
        createdAt: now,
        GSI1PK: PARTNERS_ALL_GSI1PK,
        GSI1SK: "Security probe (throwaway)",
      },
    }),
  );
  await db.send(new PutCommand({ TableName: table, Item: { ...partnerApiKeyKey(hash), partnerId: MINT_ID, keyPrefix: keyPrefixOf(key), createdAt: now } }));
  return {
    key,
    cleanup: async () => {
      await db.send(new DeleteCommand({ TableName: table, Key: partnerApiKeyKey(hash) }));
      await db.send(new DeleteCommand({ TableName: table, Key: partnerKey(MINT_ID) }));
    },
  };
}

async function main(): Promise<void> {
  const base = `https://${cfDomain()}`;
  const origins = webOrigins(stage);
  console.log(`probing ${base} (${stage})`);

  // ── headers ─────────────────────────────────────────────────────────────
  const cfg = await http(`${base}/v1/config`);
  check("headers", "/v1/config answers 200", cfg.status === 200, `got ${cfg.status}`);
  check("headers", "HSTS with a long max-age", /max-age=(\d{6,})/.test(cfg.headers.get("strict-transport-security") ?? ""), cfg.headers.get("strict-transport-security") ?? "absent");
  check("headers", "X-Content-Type-Options nosniff", (cfg.headers.get("x-content-type-options") ?? "").toLowerCase() === "nosniff");
  check("headers", "X-Frame-Options DENY", (cfg.headers.get("x-frame-options") ?? "").toUpperCase() === "DENY", cfg.headers.get("x-frame-options") ?? "absent");
  check("headers", "Referrer-Policy set", Boolean(cfg.headers.get("referrer-policy")), cfg.headers.get("referrer-policy") ?? "absent");
  check("headers", "no X-Powered-By", !cfg.headers.get("x-powered-by"));
  check("headers", "JSON content type on the API", (cfg.headers.get("content-type") ?? "").includes("application/json"), cfg.headers.get("content-type") ?? "absent");

  // ── cors ────────────────────────────────────────────────────────────────
  const allowed = origins[0] ?? "";
  const good = await http(`${base}/v1/config`, { headers: { origin: allowed } });
  check("cors", "allowlisted origin is echoed", good.headers.get("access-control-allow-origin") === allowed, `${allowed} → ${good.headers.get("access-control-allow-origin") ?? "absent"}`);
  const evil = await http(`${base}/v1/config`, { headers: { origin: "https://evil.example" } });
  const evilAcao = evil.headers.get("access-control-allow-origin");
  check("cors", "unknown origin is not echoed and no wildcard", !evilAcao || (evilAcao !== "https://evil.example" && evilAcao !== "*"), evilAcao ?? "absent");
  check("cors", "credentials never allowed", (good.headers.get("access-control-allow-credentials") ?? "false") !== "true");
  const pre = await http(`${base}/v1/content`, { method: "OPTIONS", headers: { origin: allowed, "access-control-request-method": "GET" } });
  check("cors", "preflight from the allowlisted origin succeeds", pre.status === 200 || pre.status === 204, `got ${pre.status}`);
  const preEvil = await http(`${base}/v1/content`, { method: "OPTIONS", headers: { origin: "https://evil.example", "access-control-request-method": "GET" } });
  check("cors", "preflight from an unknown origin grants nothing", (preEvil.headers.get("access-control-allow-origin") ?? "") !== "https://evil.example");

  // ── public inputs ───────────────────────────────────────────────────────
  const probes: [string, string][] = [
    ["unknown content id", `${base}/v1/content/does-not-exist-${randomToken(4)}`],
    ["path-traversal content id", `${base}/v1/content/..%2F..%2Fetc%2Fpasswd`],
    ["2 KB content id", `${base}/v1/content/${"a".repeat(2048)}`],
    ["expression-shaped content id", `${base}/v1/content/${encodeURIComponent("x' OR 1=1 --")}`],
    ["unknown profile id", `${base}/v1/profiles/nobody-${randomToken(4)}`],
    ["unknown event id", `${base}/v1/events/nothing-${randomToken(4)}`],
    ["non-numeric limit", `${base}/v1/content?limit=abc`],
    ["negative limit", `${base}/v1/content?limit=-1`],
    ["huge limit", `${base}/v1/content?limit=100000`],
    ["garbage cursor", `${base}/v1/content?cursor=${encodeURIComponent("{\"PK\":\"CONTENT#x\"}")}`],
    ["binary garbage cursor", `${base}/v1/content?cursor=%00%ff%fe`],
  ];
  for (const [name, url] of probes) {
    const r = await http(url);
    const isJson = (r.headers.get("content-type") ?? "").includes("json");
    check("public", `${name} → 4xx, clean body`, r.status >= 400 && cleanError(r) && (!isJson || apiErrorShape(r)), `got ${r.status}${isJson ? "" : " (edge-blocked)"}`);
  }
  const listOk = await http(`${base}/v1/content?channelId=ch-niltv&limit=1`);
  check("public", "content list answers 200 with a normal limit", listOk.status === 200, `got ${listOk.status}`);
  check("public", "content list never exposes staff fields", !/"(overrides|qc|keyHashes|webhookSecret|activeKeyHash)"|"source":\{"kind"/.test(listOk.body));

  for (const [name, url, body] of [
    ["newsletter: not JSON", `${base}/v1/newsletter`, "not json"],
    ["newsletter: empty object", `${base}/v1/newsletter`, "{}"],
    ["newsletter: formula-shaped email", `${base}/v1/newsletter`, JSON.stringify({ email: "=HYPERLINK(\"https://evil.example\")@x" })],
    ["newsletter: email with CR/LF", `${base}/v1/newsletter`, JSON.stringify({ email: "a@b.com\r\nbcc: c@d.com" })],
    ["newsletter: 1 MB body", `${base}/v1/newsletter`, JSON.stringify({ email: `${"a".repeat(1_000_000)}@x.com` })],
    ["telemetry: not JSON", `${base}/v1/telemetry`, "<xml/>"],
    ["telemetry: wrong shape", `${base}/v1/telemetry`, JSON.stringify({ events: "nope" })],
    ["newsletter confirm: garbage token", `${base}/v1/newsletter/confirm`, JSON.stringify({ token: "../../x" })],
  ] as [string, string, string][]) {
    const r = await http(url, { method: "POST", headers: jsonHeaders, body });
    check("public", `${name} → 4xx, clean body`, r.status >= 400 && r.status < 500 && cleanError(r), `got ${r.status}`);
  }

  // ── authed (JWT) routes ─────────────────────────────────────────────────
  const jwtRoutes: [string, string][] = [
    ["GET", "/v1/me"],
    ["DELETE", "/v1/me"],
    ["PUT", "/v1/me/follows/ath-x"],
    ["POST", "/v1/me/likes/ig-x"],
    ["POST", "/v1/events/ev-x/vote"],
    ["POST", "/v1/me/devices"],
    ["PUT", "/v1/me/push"],
    ["PUT", "/v1/me/notification-follows"],
  ];
  // Forged alg=none token, assembled here rather than stored so the secret
  // scanner does not mistake a test fixture for a credential.
  const b64u = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const garbageJwt = `${b64u({ alg: "none" })}.${b64u({ sub: "attacker", "custom:role": "staff" })}.`;
  for (const [method, path] of jwtRoutes) {
    const none = await http(`${base}${path}`, { method, headers: jsonHeaders, body: method === "GET" ? undefined : "{}" });
    check("authed", `${method} ${path} without a token → 401`, none.status === 401, `got ${none.status}`);
    const bad = await http(`${base}${path}`, { method, headers: { ...jsonHeaders, authorization: `Bearer ${garbageJwt}` }, body: method === "GET" ? undefined : "{}" });
    check("authed", `${method} ${path} with alg=none token → 401`, bad.status === 401, `got ${bad.status}`);
  }

  // ── admin routes ────────────────────────────────────────────────────────
  if (adminBase) {
    const adminRoutes: [string, string][] = [
      ["GET", "/admin/content"],
      ["POST", "/admin/content"],
      ["POST", "/admin/content/ig-x/publish"],
      ["POST", "/admin/content/ig-x/withdraw"],
      ["GET", "/admin/profiles"],
      ["GET", "/admin/partners"],
      ["POST", "/admin/partners"],
      ["POST", "/admin/partners/p-x/rotate-key"],
      ["POST", "/admin/partners/p-x/revoke-key"],
      ["GET", "/admin/series"],
      ["GET", "/admin/newsletter"],
      ["GET", "/admin/events"],
    ];
    for (const [method, path] of adminRoutes) {
      const none = await http(`${adminBase}${path}`, { method, headers: jsonHeaders, body: method === "GET" ? undefined : "{}" });
      check("admin", `${method} ${path} without a token → 401`, none.status === 401, `got ${none.status}`);
      const bad = await http(`${adminBase}${path}`, { method, headers: { ...jsonHeaders, authorization: `Bearer ${garbageJwt}` }, body: method === "GET" ? undefined : "{}" });
      check("admin", `${method} ${path} with alg=none token → 401`, bad.status === 401, `got ${bad.status}`);
    }
    const adminCors = await http(`${adminBase}/admin/content`, { method: "OPTIONS", headers: { origin: "https://evil.example", "access-control-request-method": "GET" } });
    check("admin", "admin preflight does not grant an unknown origin", (adminCors.headers.get("access-control-allow-origin") ?? "") !== "https://evil.example" && (adminCors.headers.get("access-control-allow-origin") ?? "") !== "*", adminCors.headers.get("access-control-allow-origin") ?? "absent");
  }

  // ── partner routes ──────────────────────────────────────────────────────
  const p = `${base}/partner/v1`;
  const noKey = await http(`${p}/me`);
  check("partner", "no key → 401", noKey.status === 401, `got ${noKey.status}`);
  const unknownKey = await http(`${p}/me`, { headers: { "x-api-key": `nltv_${stage}_${"x".repeat(32)}` } });
  check("partner", "unknown key → 403", unknownKey.status === 403, `got ${unknownKey.status}`);
  const shortKey = await http(`${p}/me`, { headers: { "x-api-key": "abc" } });
  check("partner", "malformed key → 403, clean body", shortKey.status === 403 && cleanError(shortKey), `got ${shortKey.status}`);
  const otherStage = await http(`${p}/me`, { headers: { "x-api-key": `nltv_${stage === "dev" ? "prod" : "dev"}_${"y".repeat(32)}` } });
  check("partner", "other-stage key prefix → 403", otherStage.status === 403, `got ${otherStage.status}`);
  const queryKey = await http(`${p}/me?x-api-key=nltv_${stage}_${"x".repeat(32)}&api_key=x`);
  check("partner", "key in the query string is ignored → 401", queryKey.status === 401, `got ${queryKey.status}`);
  const bearerKey = await http(`${p}/me`, { headers: { authorization: `Bearer nltv_${stage}_${"x".repeat(32)}` } });
  check("partner", "key as a bearer token is ignored → 401", bearerKey.status === 401, `got ${bearerKey.status}`);
  const post = await http(`${p}/content`, { method: "POST", headers: { ...jsonHeaders, "x-api-key": "abc" }, body: "{}" });
  check("partner", "POST on a read-only route is refused, never 5xx", post.status >= 400 && post.status < 500, `got ${post.status}`);
  const noKeyDetail = await http(`${p}/content/${"a".repeat(600)}`);
  check("partner", "unauthenticated long id → 401, not 5xx", noKeyDetail.status === 401, `got ${noKeyDetail.status}`);

  let partnerKeyValue = arg("partner-key");
  let cleanup: (() => Promise<void>) | undefined;
  if (!partnerKeyValue && flag("mint")) {
    const m = await mint();
    partnerKeyValue = m.key;
    cleanup = m.cleanup;
    await new Promise((r) => setTimeout(r, 1500));
  }
  try {
    if (partnerKeyValue) {
      const auth = { headers: { "x-api-key": partnerKeyValue } };
      const me = await http(`${p}/me`, auth);
      check("partner", "valid key → /me 200", me.status === 200, `got ${me.status}`);
      check("partner", "/me carries no secret fields", !/"(webhookSecret|activeKeyHash|keyHashes|keyPrefix|feedToken)"/.test(me.body));
      check("partner", "/me is not cacheable by shared caches", /no-store|private/.test(me.headers.get("cache-control") ?? ""), me.headers.get("cache-control") ?? "absent");
      const keyed: [string, string, number[]][] = [
        ["limit=0", `${p}/content?limit=0`, [400]],
        ["limit=101", `${p}/content?limit=101`, [400]],
        ["limit=abc", `${p}/content?limit=abc`, [400]],
        ["garbage cursor", `${p}/content?cursor=not-base64!`, [400]],
        ["forged cursor pointing at another partition", `${p}/content?cursor=${encodeURIComponent(Buffer.from(JSON.stringify({ PK: "PARTNER#p-x", SK: "META" })).toString("base64url"))}`, [400]],
        ["unknown content id", `${p}/content/nope-${randomToken(4)}`, [404]],
        ["traversal content id", `${p}/content/..%2F..%2Fx`, [403, 404]],
        ["changes with garbage since", `${p}/changes?since=yesterday`, [400]],
        ["changes with far-future since", `${p}/changes?since=2999-01-01T00:00:00Z`, [200]],
        ["unknown series filter", `${p}/content?series=nope`, [200, 400]],
      ];
      for (const [name, url, expected] of keyed) {
        const r = await http(url, auth);
        check("partner", `${name} → ${expected.join("/")}`, expected.includes(r.status) && cleanError(r), `got ${r.status}`);
      }
      // Contract: paging by small pages hands back the same rows, once each, in
      // the same order as paging by 100 (a cursor that points at the page
      // boundary would skip the rest of the page).
      const walk = async (limit: number, cap: number): Promise<string[]> => {
        const ids: string[] = [];
        let cursor: string | undefined;
        while (ids.length < cap) {
          const r = await http(`${p}/content?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, auth);
          if (r.status !== 200) return ids;
          const body = JSON.parse(r.body) as { items: { id: string }[]; cursor?: string };
          ids.push(...body.items.map((i) => i.id));
          if (!body.cursor) break;
          cursor = body.cursor;
        }
        return ids.slice(0, cap);
      };
      const bySeven = await walk(7, 60);
      const byHundred = await walk(100, 60);
      check("partner", "paging by 7 and by 100 agree, no row skipped or repeated", bySeven.length === byHundred.length && bySeven.every((id, i) => id === byHundred[i]) && new Set(bySeven).size === bySeven.length, `${bySeven.length} vs ${byHundred.length} rows`);
      const timed = Date.now();
      await http(`${p}/content?limit=50`, auth);
      check("partner", "a 50-row page answers within 3 s", Date.now() - timed < 3000, `${Date.now() - timed} ms`);

      const list = await http(`${p}/content?limit=1`, auth);
      // files.source is the partner's original-file entry; the staff `source` record is the object with a `kind`.
      check("partner", "content list never leaks staff fields", !/"(overrides|qc|activeKeyHash|webhookSecret|unresolvedHandles|incompleteProfile)"|"source":\{"kind"/.test(list.body));
    } else {
      console.log("(partner keyed probes skipped: pass --partner-key or --mint)");
    }
  } finally {
    if (cleanup) await cleanup();
  }

  // ── downloads + feeds ───────────────────────────────────────────────────
  const dl = await ssm(`/niltv/${stage}/partner-dl/domain`);
  if (dl) {
    const unsigned = await http(`https://${dl}/video/ig-x/mezz.mp4`);
    check("downloads", "unsigned download URL → 403", unsigned.status === 403, `got ${unsigned.status}`);
    const fakeSig = await http(`https://${dl}/video/ig-x/mezz.mp4?Expires=${Math.floor(Date.now() / 1000) + 3600}&Signature=AAAA&Key-Pair-Id=K000000000000`);
    check("downloads", "forged signature → 403", fakeSig.status === 403, `got ${fakeSig.status}`);
    const originals = await http(`https://${dl}/originals/anything.mp4`);
    check("downloads", "originals path unsigned → 403", originals.status === 403, `got ${originals.status}`);
  } else {
    console.log("(download probes skipped: no AWS credentials to read the download domain)");
  }
  const feed = await http(`${base}/feeds/${randomToken(8)}/mrss.xml`);
  check("downloads", "feed with an unknown token is not served", feed.status === 403 || feed.status === 404, `got ${feed.status}`);
  const feedList = await http(`${base}/feeds/`);
  check("downloads", "feed root is not listable", feedList.status === 403 || feedList.status === 404, `got ${feedList.status}`);
  const publicMezz = await http(`${base}/video/ig-x/mezz.mp4`);
  check("downloads", "mezzanine is not on the public distribution", publicMezz.status === 403 || publicMezz.status === 404, `got ${publicMezz.status}`);

  // ── summary ─────────────────────────────────────────────────────────────
  const failed = checks.filter((c) => !c.ok);
  const byGroup = new Map<string, { pass: number; total: number }>();
  for (const c of checks) {
    const g = byGroup.get(c.group) ?? { pass: 0, total: 0 };
    g.total += 1;
    if (c.ok) g.pass += 1;
    byGroup.set(c.group, g);
  }
  console.log("");
  for (const [g, n] of byGroup) console.log(`${g.padEnd(10)} ${n.pass}/${n.total}`);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed against ${stage}`);
  const out = arg("json");
  if (out) writeFileSync(out, JSON.stringify({ stage, at: new Date().toISOString(), checks }, null, 2));
  if (failed.length > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
