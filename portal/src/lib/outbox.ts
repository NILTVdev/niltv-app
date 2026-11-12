/**
 * Unsent messages and composer drafts, kept outside the thread screen and
 * keyed by conversation id. Opening another thread unmounts the old one, so
 * anything held in component state would vanish with it: a send that fails
 * after you leave, its Retry, and half-written text. Here they wait until
 * you come back. Cleared on sign-out. Lives for the page load only.
 */
import { useSyncExternalStore } from "react";
import type { Mention } from "./mentions";

/** What the composer hands over: the text, who it @mentions, and the Important flag. */
export interface Draft {
  body: string;
  mentions: string[];
  important: boolean;
}

export interface PendingMessage extends Draft {
  clientMsgId: string;
  at: string;
  state: "sending" | "failed";
  error?: string;
}

/** The composer's box as typed, before it becomes a Draft. */
export interface ComposerDraft {
  text: string;
  picked: Mention[];
  important: boolean;
}

/* ── pure list steps ───────────────────────────────────────────────────── */

/** Add a send, or replace the one with the same clientMsgId (a retry). */
export const upsertPending = (list: PendingMessage[], item: PendingMessage): PendingMessage[] => [
  ...list.filter((p) => p.clientMsgId !== item.clientMsgId),
  item,
];

export const markFailed = (list: PendingMessage[], clientMsgId: string, error: string): PendingMessage[] =>
  list.map((p) => (p.clientMsgId === clientMsgId ? { ...p, state: "failed", error } : p));

export const removePending = (list: PendingMessage[], clientMsgId: string): PendingMessage[] =>
  list.filter((p) => p.clientMsgId !== clientMsgId);

/** The toast when a send fails while its thread is not on screen. */
export const failedNotice = (title: string | undefined): string =>
  title ? `A message to ${title} was not sent. Open it to retry.` : "A message was not sent. Open the thread to retry.";

/** A draft worth keeping: anything typed. */
export const keepDraft = (d: ComposerDraft): boolean => d.text.trim().length > 0;

/* ── the store ─────────────────────────────────────────────────────────── */

const EMPTY: PendingMessage[] = [];
const pendingByConv = new Map<string, PendingMessage[]>();
const drafts = new Map<string, ComposerDraft>();
const onScreen = new Map<string, number>();
const listeners = new Set<() => void>();
let version = 0;

const notify = () => {
  version++;
  listeners.forEach((l) => l());
};

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export const pendingFor = (convId: string): PendingMessage[] => pendingByConv.get(convId) ?? EMPTY;

export function updatePending(convId: string, step: (list: PendingMessage[]) => PendingMessage[]): void {
  const next = step(pendingFor(convId));
  if (next.length) pendingByConv.set(convId, next);
  else pendingByConv.delete(convId);
  notify();
}

/** A thread's unsent messages, re-rendering when they change. */
export function usePending(convId: string): PendingMessage[] {
  return useSyncExternalStore(
    subscribe,
    () => pendingFor(convId),
    () => EMPTY,
  );
}

/** Re-render on any outbox change (for lists that show many threads). */
export const useOutboxVersion = (): number =>
  useSyncExternalStore(
    subscribe,
    () => version,
    () => 0,
  );

export const hasFailed = (convId: string): boolean => pendingFor(convId).some((p) => p.state === "failed");

export const draftFor = (convId: string): ComposerDraft | undefined => drafts.get(convId);

export function saveDraft(convId: string, draft: ComposerDraft): void {
  if (keepDraft(draft)) drafts.set(convId, draft);
  else drafts.delete(convId);
}

/** Mark a thread as on screen; call the result when it leaves. */
export function showThread(convId: string): () => void {
  onScreen.set(convId, (onScreen.get(convId) ?? 0) + 1);
  return () => {
    const n = (onScreen.get(convId) ?? 1) - 1;
    if (n > 0) onScreen.set(convId, n);
    else onScreen.delete(convId);
  };
}

export const isOnScreen = (convId: string): boolean => (onScreen.get(convId) ?? 0) > 0;

/** Bumped by clearOutbox(): a send that settles after a sign-out sees a new epoch and stays quiet. */
let epoch = 0;
export const outboxEpoch = (): number => epoch;

/* ── held resends after a 429 ──────────────────────────────────────────── */

/**
 * A send refused with 429 waits here, not in the thread screen, so the
 * timer outlives an unmount and still answers to Discard and sign-out.
 * Keyed by conversation and clientMsgId.
 */
interface Held {
  timer?: ReturnType<typeof setTimeout>;
  tries: number;
}
const held = new Map<string, Held>();
const heldKey = (convId: string, clientMsgId: string) => `${convId}\u0000${clientMsgId}`;
const isPending = (convId: string, clientMsgId: string) => pendingFor(convId).some((p) => p.clientMsgId === clientMsgId);

/** What holdForResend did: held it, found it discarded or signed out, or ran out of resends. */
export type HoldResult = "held" | "gone" | "spent";

/**
 * Hold a send refused with 429 and run `resend` after `waitMs`. `epoch` is
 * the outbox epoch the send started in. The resend is dropped if the member
 * signs out or discards the message first. After `max` holds it is "spent"
 * and the caller marks it failed.
 */
export function holdForResend(
  convId: string,
  clientMsgId: string,
  opts: { waitMs: number; epoch: number; max: number; resend: () => void },
): HoldResult {
  const key = heldKey(convId, clientMsgId);
  const prev = held.get(key);
  if (prev?.timer !== undefined) clearTimeout(prev.timer);
  if (opts.epoch !== epoch || !isPending(convId, clientMsgId)) {
    held.delete(key);
    return "gone";
  }
  const tries = prev?.tries ?? 0;
  if (tries >= opts.max) {
    held.delete(key);
    return "spent";
  }
  const entry: Held = { tries: tries + 1 };
  entry.timer = setTimeout(() => {
    if (held.get(key) !== entry) return;
    // Keep the count for the next refusal; the timer itself is done.
    entry.timer = undefined;
    if (opts.epoch !== epoch || !isPending(convId, clientMsgId)) {
      held.delete(key);
      return;
    }
    opts.resend();
  }, opts.waitMs);
  held.set(key, entry);
  return "held";
}

/** Stop any held resend and forget its count. Call on success, final failure, or a fresh send. */
export function forgetResend(convId: string, clientMsgId: string): void {
  const key = heldKey(convId, clientMsgId);
  const h = held.get(key);
  if (h?.timer !== undefined) clearTimeout(h.timer);
  held.delete(key);
}

/** True while a resend timer is waiting for this message. */
export const isHeld = (convId: string, clientMsgId: string): boolean =>
  held.get(heldKey(convId, clientMsgId))?.timer !== undefined;

/** The member discards an unsent message: it leaves the outbox and is never sent again. */
export function discardPending(convId: string, clientMsgId: string): void {
  forgetResend(convId, clientMsgId);
  updatePending(convId, (list) => removePending(list, clientMsgId));
}

/** Sign-out: nothing typed or unsent may carry over to the next account in this tab. */
export function clearOutbox(): void {
  epoch++;
  for (const h of held.values()) if (h.timer !== undefined) clearTimeout(h.timer);
  held.clear();
  pendingByConv.clear();
  drafts.clear();
  notify();
}
