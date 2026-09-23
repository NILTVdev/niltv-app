/**
 * Partner API key material (partner content API). Keys are random, carry the
 * stage in plain sight so a prod key pasted into dev fails loudly, and are
 * stored only as a salted SHA-256: the pepper lives in Secrets Manager and
 * reaches the authorizer/admin handlers as an environment variable, so a
 * table dump alone never yields a working credential.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** URL-safe random string of `length` base62 characters (crypto, not Math.random). */
export function randomToken(length = 32): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i += 1) out += ALPHABET[(bytes[i] ?? 0) % ALPHABET.length];
  return out;
}

/** `nltv_{stage}_{32 chars}` — the prefix is what support conversations quote. */
export function generateApiKey(stage: string): string {
  return `nltv_${stage}_${randomToken(32)}`;
}

/** First 12 characters — enough to identify a key, never enough to use it. */
export const keyPrefixOf = (apiKey: string): string => apiKey.slice(0, 12);

/** Salted SHA-256 hex of a plain key. The pepper is required; an empty pepper is a deployment bug. */
export function hashApiKey(pepper: string, apiKey: string): string {
  if (!pepper) throw new Error("PARTNER_KEY_PEPPER is unset — refusing to hash an API key without a pepper");
  return createHash("sha256").update(`${pepper}:${apiKey}`).digest("hex");
}

/** Loose shape check before hashing, so garbage headers never reach DynamoDB. */
export const looksLikeApiKey = (value: string | undefined): value is string =>
  typeof value === "string" && /^nltv_[a-z]+_[A-Za-z0-9]{32}$/.test(value);

/** HMAC-SHA256 of a webhook body, as the partner verifies it: `sha256=<hex>`. */
export function webhookSignature(secret: string, timestamp: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

/** Constant-time comparison for signature checks (used by tests and any inbound verification). */
export function signaturesMatch(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
