/**
 * Pure vote-path helpers (design §6.3), colocated here so the window rule is
 * unit-testable without an AWS client.
 */
import type { Item } from "./shape";

/**
 * Window gate: stored status must be `live` AND now must sit inside
 * [startsAt, endsAt]. Both conditions on purpose — a lagging scheduler or a
 * manual override can widen neither side of the window. Malformed timestamps
 * fail closed.
 */
export function isVoteWindowOpen(eventRow: Item, now: Date): boolean {
  if (eventRow["status"] !== "live") return false;
  const startsAt = Date.parse(String(eventRow["startsAt"]));
  const endsAt = Date.parse(String(eventRow["endsAt"]));
  if (Number.isNaN(startsAt) || Number.isNaN(endsAt)) return false;
  const t = now.getTime();
  return t >= startsAt && t <= endsAt;
}

/** JSON request body, base64-aware; undefined for absent/unparseable (caller 400s via zod). */
export function parseVoteBody(body: string | undefined, isBase64Encoded: boolean): unknown {
  if (body === undefined || body === "") return undefined;
  const raw = isBase64Encoded ? Buffer.from(body, "base64").toString("utf8") : body;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}
