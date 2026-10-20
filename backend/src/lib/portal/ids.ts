/**
 * Portal ids. Messages use ULIDs (time-ordered sort keys, no same-millisecond
 * collisions); events, postings and requests use a short prefix plus a
 * lowercase ULID so their ids sort by creation time too.
 */
import { randomBytes } from "node:crypto";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** 26-char ULID: 10 chars of millisecond time, 16 chars of randomness. */
export function ulid(now: number = Date.now()): string {
  let time = "";
  let t = Math.max(0, Math.floor(now));
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const bytes = randomBytes(16);
  let rand = "";
  for (let i = 0; i < 16; i++) rand += CROCKFORD[(bytes[i] ?? 0) % 32];
  return time + rand;
}

/** `{prefix}-{ulid}` in lowercase, e.g. `ev-01jb2…`. */
export const newPortalId = (prefix: string, now?: number): string => `${prefix}-${ulid(now).toLowerCase()}`;

/** URL-safe slug for channel ids: "Women's Basketball" → "womens-basketball". */
export function slugify(input: string): string {
  const cleaned = input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned.length > 0 ? cleaned : "other";
}
