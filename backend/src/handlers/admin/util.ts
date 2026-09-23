/**
 * Shared helpers for the admin handlers only (src/lib/* is owned by the
 * public-API surface; anything admin-specific lives here).
 */
import { randomBytes } from "node:crypto";
import { ApiError } from "@niltv/types";
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { json } from "../../lib/http";

/** PK prefix of content items — mirrors the key shape of `contentKey` in lib/db. */
export const CONTENT_PK_PREFIX = "CONTENT#";

/* ── Ids ──────────────────────────────────────────────────────────────────── */

/** URL/key-safe slug: lowercase ascii, runs of anything else collapse to `-`. */
export function slug(input: string): string {
  const cleaned = input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip combining diacritics left by NFKD
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned.length > 0 ? cleaned : "untitled";
}

/** Content id: `c-{slug(title)}-{4 hex chars}` — the random tail (crypto, not Math.random) de-dupes retitled/re-added clips. */
export function newContentId(title: string): string {
  return `c-${slug(title)}-${randomBytes(2).toString("hex")}`;
}

/** Profile id: `ath-{slug(name)}` — deterministic; a duplicate name trips the create condition instead of forking the person. */
export function newProfileId(name: string): string {
  return `ath-${slug(name)}`;
}

/** Event id: `ev-{slug(title)}-{4 hex chars}` — random tail de-dupes annual reruns of the same title. */
export function newEventId(title: string): string {
  return `ev-${slug(title)}-${randomBytes(2).toString("hex")}`;
}

/** Entry id: `en-{athleteId minus its ath- prefix}` — deterministic, so one athlete can hold at most one entry per event. */
export function newEntryId(athleteId: string): string {
  return `en-${athleteId.replace(/^ath-/, "")}`;
}

/**
 * Rank-first GSI1SK for the PROFILES#ALL directory partition — must mirror
 * scripts/seed.ts exactly: zero-padded rank ("01" < "02" < … < any letter)
 * when ranked, else the display name for alphabetical order.
 */
export function profileGsi1Sk(profile: { ambassadorRank?: number | undefined; name: string }): string {
  return profile.ambassadorRank !== undefined
    ? String(profile.ambassadorRank).padStart(2, "0")
    : profile.name;
}

/* ── Requests / responses ─────────────────────────────────────────────────── */

/**
 * JSON request body, base64-aware. Returns `{}` for an absent body (all admin
 * POST bodies are zod-defaulted objects) and `undefined` for unparseable JSON
 * so callers can 400.
 */
export function parseJsonBody(event: APIGatewayProxyEventV2): unknown {
  if (event.body === undefined || event.body === "") return {};
  const raw = event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/** 400 with the standard ApiError envelope. */
export const badRequest = (message: string): APIGatewayProxyStructuredResultV2 =>
  json(400, ApiError.parse({ error: "BAD_REQUEST", message }));

/** 409 with a caller-chosen code (NOT_READY for the publish gate, CONFLICT for id collisions). */
export const conflict = (error: string, message: string): APIGatewayProxyStructuredResultV2 =>
  json(409, ApiError.parse({ error, message }));

/** True when a single-item write failed only its ConditionExpression. */
export function isConditionalCheckFailed(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { name?: string }).name === "ConditionalCheckFailedException"
  );
}
