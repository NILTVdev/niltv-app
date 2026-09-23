/**
 * Partner content API — admin-route flow on DEV, end to end through the real
 * staff surface (the smoke test bypasses it with direct table writes).
 *
 *   npx tsx scripts/partner-admin-flow.ts --stage dev
 *
 *   1. Creates a temporary staff user in the dev pool and mints an id token.
 *   2. Through the admin API: creates a series, creates a partner whose
 *      webhook points at a fresh webhook.site receiver, tags one real clip
 *      into the series (rights licensed / marks cleared / no music).
 *   3. Through CloudFront with the issued key: /me and /content/{id}.
 *   4. Rebuilds feeds, fetches the Media RSS URL, and runs it through the
 *      W3C Feed Validation Service.
 *   5. Withdraws and restores the clip via the admin routes, then waits for
 *      the published / withdrawn / updated webhooks and verifies each HMAC.
 *   6. Rotates the key (both work), revokes it, suspends the partner and
 *      proves the next feed build is empty.
 *   7. Removes everything it created and restores the clip. Refuses prod.
 */
import {
  AdminAddUserToGroupCommand,
  AdminConfirmSignUpCommand,
  AdminDeleteUserCommand,
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
  SignUpCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { DeleteObjectsCommand, ListBucketsCommand, S3Client } from "@aws-sdk/client-s3";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { DeleteCommand, GetCommand, QueryCommand, ScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { contentKey, getDocClient, partnerApiKeyKey, partnerKey, seriesKey } from "../src/lib/db";
import { hashApiKey, signaturesMatch, webhookSignature } from "../src/lib/partner-keys";
import type { Item } from "../src/lib/shape";

const stage = process.argv.includes("--stage") ? process.argv[process.argv.indexOf("--stage") + 1] : "dev";
if (stage !== "dev") throw new Error("partner-admin-flow: dev only");
const table = "niltv-dev";
process.env.TABLE_NAME = table;
const USER_POOL_ID = "us-east-1_fxm8vObBQ";
const TEST_CLIENT_ID = "7ninm1g7ro3b9df4mqnhpds05r";
const ADMIN_BASE = process.env.ADMIN_API_URL ?? "https://wbcz89dvh3.execute-api.us-east-1.amazonaws.com";

const cognito = new CognitoIdentityProviderClient({ region: "us-east-1" });
const db = getDocClient();
const checks: { name: string; ok: boolean; detail?: string }[] = [];
const check = (name: string, ok: boolean, detail?: string) => {
  checks.push({ name, ok, ...(detail ? { detail } : {}) });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function call(base: string, method: string, path: string, headers: Record<string, string>, body?: unknown) {
  const res = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json", ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, json: json as Record<string, unknown> | undefined, text };
}

function cfDomain(): string {
  const ctx = JSON.parse(readFileSync(join(__dirname, "..", "cdk.json"), "utf8")) as { context: Record<string, string> };
  return ctx.context["niltv:cfDomain:dev"] ?? "";
}

async function pickClip(): Promise<Item> {
  let startKey: Record<string, unknown> | undefined;
  do {
    const out = await db.send(
      new ScanCommand({
        TableName: table,
        FilterExpression: "begins_with(PK, :c) AND transcodeStatus = :p AND attribute_not_exists(withdrawnAt) AND attribute_not_exists(seriesId)",
        ExpressionAttributeValues: { ":c": "CONTENT#", ":p": "published" },
        ExclusiveStartKey: startKey,
      }),
    );
    const hit = ((out.Items ?? []) as Item[]).find((r) => typeof r["playbackPath"] === "string" && r["playbackPath"].endsWith("/master.mp4"));
    if (hit) return hit;
    startKey = out.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (startKey);
  throw new Error("no published social clip found");
}

async function main(): Promise<void> {
  const publicBase = `https://${cfDomain()}`;
  const runId = Date.now().toString(36);
  const staffEmail = `partnerflow-${runId}@niltv.invalid`;
  const staffPassword = `Flow-${runId}-Aa1!`;
  let staffSub: string | undefined;
  let hookUuid: string | undefined;
  let seriesId: string | undefined;
  let partnerId: string | undefined;
  const issuedKeys: string[] = [];
  let feedToken: string | undefined;
  let clip: Item | undefined;
  let original: Record<string, unknown> = {};

  try {
    // ── 1. temporary staff user ──────────────────────────────────────────
    const signup = await cognito.send(
      new SignUpCommand({
        ClientId: TEST_CLIENT_ID,
        Username: staffEmail,
        Password: staffPassword,
        UserAttributes: [
          { Name: "email", Value: staffEmail },
          { Name: "name", Value: "Partner Flow" },
          { Name: "birthdate", Value: "1990-01-01" },
        ],
      }),
    );
    staffSub = signup.UserSub;
    await cognito.send(new AdminConfirmSignUpCommand({ UserPoolId: USER_POOL_ID, Username: staffEmail }));
    await cognito.send(new AdminAddUserToGroupCommand({ UserPoolId: USER_POOL_ID, Username: staffEmail, GroupName: "staff" }));
    const auth = await cognito.send(
      new InitiateAuthCommand({
        ClientId: TEST_CLIENT_ID,
        AuthFlow: "USER_PASSWORD_AUTH",
        AuthParameters: { USERNAME: staffEmail, PASSWORD: staffPassword },
      }),
    );
    const idToken = auth.AuthenticationResult?.IdToken;
    if (!idToken) throw new Error("no id token");
    const staff = { authorization: `Bearer ${idToken}` };
    check("temporary staff user minted a token", true);

    // ── 2. webhook receiver ──────────────────────────────────────────────
    const tokenRes = await fetch("https://webhook.site/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ default_status: 200, default_content: "ok", timeout: 0 }),
    });
    hookUuid = ((await tokenRes.json()) as { uuid: string }).uuid;
    const webhookUrl = `https://webhook.site/${hookUuid}`;

    // ── admin: series ────────────────────────────────────────────────────
    const series = await call(ADMIN_BASE, "POST", "/admin/series", staff, {
      name: `Admin Flow Series ${runId}`,
      kind: "show",
      defaultRights: { status: "owned", logoCleared: true, music: "cleared" },
      syndicationDelayDays: 0,
    });
    seriesId = series.json?.["id"] as string | undefined;
    check("POST /admin/series → 201", series.status === 201 && Boolean(seriesId), `status ${series.status}`);
    const seriesList = await call(ADMIN_BASE, "GET", "/admin/series", staff);
    check("GET /admin/series lists it", seriesList.status === 200 && seriesList.text.includes(`"id":"${seriesId}"`));

    // ── admin: partner (before tagging, so the publish event has a subscriber)
    const created = await call(ADMIN_BASE, "POST", "/admin/partners", staff, {
      name: `Admin Flow Partner ${runId}`,
      contact: "partner-admin-flow@example.com",
      licence: { seriesIds: [seriesId], channelIds: [], assetTypes: ["episode", "clip", "short"] },
      webhookUrl,
      webhookEnabled: true,
      categoryMap: seriesId ? { [seriesId]: "College Sports" } : {},
    });
    const partner = created.json?.["partner"] as { id: string; feedToken?: string } | undefined;
    partnerId = partner?.id;
    const apiKey1 = created.json?.["apiKey"] as string | undefined;
    const webhookSecret = created.json?.["webhookSecret"] as string | undefined;
    feedToken = partner?.feedToken;
    if (apiKey1) issuedKeys.push(apiKey1);
    check("POST /admin/partners → 201 with key + secret", created.status === 201 && Boolean(apiKey1 && webhookSecret && partnerId), `status ${created.status} ${created.text.slice(0, 120)}`);
    const rejected = await call(ADMIN_BASE, "POST", "/admin/partners", staff, { name: `Bad Hook ${runId}`, webhookUrl: "http://169.254.169.254/x" });
    check("http/IP-literal webhook URL is refused (400)", rejected.status === 400, `status ${rejected.status}`);
    const list = await call(ADMIN_BASE, "GET", "/admin/partners", staff);
    check("GET /admin/partners never carries secrets", list.status === 200 && !list.text.includes("webhookSecret") && !list.text.includes("activeKeyHash"));
    if (!apiKey1 || !partnerId || !webhookSecret || !seriesId) throw new Error("partner creation failed; stopping");

    // ── admin: tag a clip ────────────────────────────────────────────────
    clip = await pickClip();
    const clipId = String(clip["id"]);
    original = { rights: clip["rights"], seriesId: clip["seriesId"], assetType: clip["assetType"], syndicationUpdatedAt: clip["syndicationUpdatedAt"], GSI3PK: clip["GSI3PK"], GSI3SK: clip["GSI3SK"], tags: clip["tags"] };
    console.log(`tagging ${clipId} ("${String(clip["title"]).slice(0, 40)}")`);
    const tagged = await call(ADMIN_BASE, "POST", "/admin/content", staff, {
      id: clipId,
      title: clip["title"],
      description: clip["description"] ?? "",
      channelId: clip["channelId"],
      athleteId: clip["athleteId"],
      rightsConfirmed: clip["rightsConfirmed"] === true,
      seriesId,
      assetType: "clip",
      rights: { status: "licensed", logoCleared: true, music: "none" },
      tags: ["flow", "test"],
    });
    check("POST /admin/content tags the clip (200)", tagged.status === 200, `status ${tagged.status} ${tagged.text.slice(0, 100)}`);
    const { Item: row } = await db.send(new GetCommand({ TableName: table, Key: contentKey(clipId) }));
    check("tagging stamped the syndication index (GSI3)", typeof row?.["GSI3PK"] === "string" && typeof row?.["syndicationUpdatedAt"] === "string");

    // ── 3. partner surface with the issued key ───────────────────────────
    const me = await call(publicBase, "GET", "/partner/v1/me", { "x-api-key": apiKey1 });
    check("/me with the issued key → 200", me.status === 200 && me.json?.["partner"] !== undefined, `status ${me.status}`);
    const feeds = (me.json?.["feeds"] ?? {}) as { mrss?: string; json?: string };
    const detail = await call(publicBase, "GET", `/partner/v1/content/${clipId}`, { "x-api-key": apiKey1 });
    check("/content/{id} → 200 with category from the partner map", detail.status === 200 && detail.json?.["category"] === "College Sports", `status ${detail.status}`);

    // ── 4. feeds + W3C validator ─────────────────────────────────────────
    const lambda = new LambdaClient({});
    await lambda.send(new InvokeCommand({ FunctionName: "niltv-dev-partner-feed-build" }));
    const feed = feeds.mrss ? await fetch(`${feeds.mrss}?v=${Date.now()}`) : undefined;
    const feedXml = feed ? await feed.text() : "";
    check("MRSS feed carries the tagged clip", feed?.status === 200 && feedXml.includes(`<guid isPermaLink="false">${clipId}</guid>`));
    if (feeds.mrss) {
      const v = await fetch(`https://validator.w3.org/feed/check.cgi?url=${encodeURIComponent(feeds.mrss)}`);
      const html = (await v.text()).replace(/<script[\s\S]*?<\/script>/g, "");
      const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
      const valid = /Congratulations!|This is a valid RSS feed/.test(text);
      const idx = text.search(/Sorry|This feed does not validate|Recommendations/);
      check("W3C Feed Validation Service: valid RSS", valid, idx >= 0 ? text.slice(idx, idx + 320) : "");
    }

    // ── 5. withdraw / restore + webhooks ─────────────────────────────────
    const withdrawn = await call(ADMIN_BASE, "POST", `/admin/content/${clipId}/withdraw`, staff, { reason: "admin flow test" });
    check("POST /admin/content/{id}/withdraw → 200", withdrawn.status === 200, `status ${withdrawn.status}`);
    const gone = await call(publicBase, "GET", `/partner/v1/content/${clipId}`, { "x-api-key": apiKey1 });
    check("withdrawn → partner 404", gone.status === 404, `status ${gone.status}`);
    const restored = await call(ADMIN_BASE, "POST", `/admin/content/${clipId}/restore`, staff);
    check("POST /admin/content/{id}/restore → 200", restored.status === 200, `status ${restored.status}`);

    // webhooks: tagging is "published" when the clip was outside the index
    // before, "updated" when the sandbox rules already had it in;
    // then withdrawn, then updated (restore).
    const firstEvent = typeof original["GSI3PK"] === "string" ? "content.updated" : "content.published";
    let received: { headers: Record<string, string[]>; content: string }[] = [];
    for (let i = 0; i < 18; i += 1) {
      const r = await fetch(`https://webhook.site/token/${hookUuid}/requests?sorting=oldest`);
      const data = ((await r.json()) as { data: { headers: Record<string, string[]>; content: string }[] }).data ?? [];
      received = data.filter((d) => d.headers["x-niltv-event"]);
      if (received.length >= 3) break;
      await sleep(5000);
    }
    const types = received.map((d) => d.headers["x-niltv-event"]?.[0]);
    check(`webhooks delivered: ${firstEvent.slice(8)} (tagging), withdrawn, updated (restore)`, [firstEvent, "content.withdrawn", "content.updated"].every((t) => types.includes(t)), types.join(", ") || "none");
    const sigOk = received.length > 0 && received.every((d) => {
      const ts = d.headers["x-niltv-timestamp"]?.[0] ?? "";
      const sig = d.headers["x-niltv-signature"]?.[0] ?? "";
      return signaturesMatch(sig, webhookSignature(webhookSecret, ts, d.content));
    });
    check("every webhook HMAC verifies with the issued secret", sigOk);
    const bodyOk = received.every((d) => {
      const body = JSON.parse(d.content) as { contentId: string; eventId: string };
      return body.contentId === clipId && typeof body.eventId === "string";
    });
    check("webhook bodies carry only id/type/version", bodyOk);
    const log = await db.send(new QueryCommand({ TableName: table, KeyConditionExpression: "PK = :pk AND begins_with(SK, :w)", ExpressionAttributeValues: { ":pk": `PARTNER#${partnerId}`, ":w": "WEBHOOK#" } }));
    check("delivery log rows written on the partner partition", (log.Items?.length ?? 0) >= 3, `${log.Items?.length ?? 0} rows`);

    // ── 6. rotate / revoke / suspend ─────────────────────────────────────
    const rotated = await call(ADMIN_BASE, "POST", `/admin/partners/${partnerId}/rotate-key`, staff);
    const apiKey2 = rotated.json?.["apiKey"] as string | undefined;
    if (apiKey2) issuedKeys.push(apiKey2);
    check("rotate-key → new key + grace on the old one", rotated.status === 200 && Boolean(apiKey2) && typeof rotated.json?.["previousKeyExpiresAt"] === "string", `status ${rotated.status}`);
    const withNew = await call(publicBase, "GET", "/partner/v1/me", { "x-api-key": apiKey2 ?? "" });
    check("new key works", withNew.status === 200, `status ${withNew.status}`);
    const withOld = await call(publicBase, "GET", "/partner/v1/me", { "x-api-key": apiKey1 });
    check("old key still works during grace", withOld.status === 200, `status ${withOld.status}`);
    const revoked = await call(ADMIN_BASE, "POST", `/admin/partners/${partnerId}/revoke-key`, staff);
    check("revoke-key → 200 (takes effect within the 5-min authorizer cache)", revoked.status === 200, `status ${revoked.status}`);

    const suspended = await call(ADMIN_BASE, "POST", "/admin/partners", staff, { id: partnerId, name: `Admin Flow Partner ${runId}`, status: "suspended" });
    check("suspend partner via upsert → 200", suspended.status === 200, `status ${suspended.status}`);
    await lambda.send(new InvokeCommand({ FunctionName: "niltv-dev-partner-feed-build" }));
    const emptyFeed = feeds.mrss ? await (await fetch(`${feeds.mrss}?v=${Date.now()}`)).text() : "";
    check("suspended partner's feed rebuilds empty with a reason", emptyFeed.includes("suspended") && !emptyFeed.includes("<item>"));
  } finally {
    console.log("cleanup…");
    try {
      const pepper = (await new SecretsManagerClient({}).send(new GetSecretValueCommand({ SecretId: "niltv-dev-partner-key-pepper" }))).SecretString ?? "";
      for (const key of issuedKeys) await db.send(new DeleteCommand({ TableName: table, Key: partnerApiKeyKey(hashApiKey(pepper, key)) }));
      if (partnerId) {
        const rows = await db.send(new QueryCommand({ TableName: table, KeyConditionExpression: "PK = :pk", ExpressionAttributeValues: { ":pk": `PARTNER#${partnerId}` } }));
        for (const r of rows.Items ?? []) await db.send(new DeleteCommand({ TableName: table, Key: { PK: r["PK"], SK: r["SK"] } }));
      }
      if (seriesId) await db.send(new DeleteCommand({ TableName: table, Key: seriesKey(seriesId) }));
      if (clip) {
        const sets: string[] = [];
        const removes = ["withdrawnAt", "withdrawnReason"];
        const values: Record<string, unknown> = {};
        const names: Record<string, string> = {};
        for (const [field, value] of Object.entries(original)) {
          const alias = `#${field}`;
          names[alias] = field;
          if (value === undefined) removes.push(alias);
          else {
            sets.push(`${alias} = :${field}`);
            values[`:${field}`] = value;
          }
        }
        await db.send(
          new UpdateCommand({
            TableName: table,
            Key: contentKey(String(clip["id"])),
            UpdateExpression: `${sets.length ? `SET ${sets.join(", ")} ` : ""}REMOVE ${removes.join(", ")}`,
            ExpressionAttributeNames: names,
            ...(Object.keys(values).length ? { ExpressionAttributeValues: values } : {}),
          }),
        );
      }
      if (partnerId && feedToken) {
        const { Buckets } = await new S3Client({}).send(new ListBucketsCommand({}));
        const bucket = (Buckets ?? []).map((b) => b.Name ?? "").find((n) => n.startsWith("niltv-dev-video-hls-"));
        if (bucket) {
          await new S3Client({}).send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: [{ Key: `feeds/${partnerId}-${feedToken}.xml` }, { Key: `feeds/${partnerId}-${feedToken}.json` }] } }));
        }
      }
      await cognito.send(new AdminDeleteUserCommand({ UserPoolId: USER_POOL_ID, Username: staffEmail })).catch(() => undefined);
      if (staffSub) await db.send(new DeleteCommand({ TableName: table, Key: { PK: `USER#${staffSub}`, SK: "META" } }));
      if (hookUuid) await fetch(`https://webhook.site/token/${hookUuid}`, { method: "DELETE" }).catch(() => undefined);
      console.log("cleanup done");
    } catch (err) {
      console.error("cleanup problem (inspect the dev table for leftovers)", err);
    }
  }
  const failed = checks.filter((c) => !c.ok).length;
  console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
