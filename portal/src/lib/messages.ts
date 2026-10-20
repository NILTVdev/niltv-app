/**
 * Message list bookkeeping for a thread: the newest page, older pages, the
 * delta poll and optimistic sends all merge into one list, oldest first.
 * Pure, so the merge rules are unit tested.
 */
import type { PortalMessage } from "@niltv/types";

/** Merge incoming messages by id (incoming wins, so hide/unhide lands), sorted by seq. */
export function mergeMessages(existing: readonly PortalMessage[], incoming: readonly PortalMessage[]): PortalMessage[] {
  if (incoming.length === 0) return existing as PortalMessage[];
  const byId = new Map(existing.map((m) => [m.id, m]));
  for (const m of incoming) byId.set(m.id, m);
  return [...byId.values()].sort((a, b) => a.seq - b.seq || a.id.localeCompare(b.id));
}

/** The highest seq in a list, 0 when empty. */
export const newestSeq = (messages: readonly PortalMessage[]): number =>
  messages.reduce((max, m) => (m.seq > max ? m.seq : max), 0);

/** The id to pass as ?after= for the delta poll. */
export const lastId = (messages: readonly PortalMessage[]): string | undefined => {
  let best: PortalMessage | undefined;
  for (const m of messages) if (!best || m.seq > best.seq) best = m;
  return best?.id;
};

/** A client message id: a UUID where the browser has one, random hex otherwise. */
export function newClientMsgId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  const bytes = new Uint8Array(16);
  if (c && typeof c.getRandomValues === "function") c.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
