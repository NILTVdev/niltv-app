/**
 * One open thread's messages: the newest page, older pages on demand, the
 * 5 s delta poll (?after=) while the tab is visible, optimistic sends with
 * retry on the same clientMsgId, and the read marker.
 */
import type { MessagesResponse, PortalMessage } from "@niltv/types";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, errorText } from "../../api";
import { lastId, mergeMessages, newClientMsgId, newestSeq } from "../../lib/messages";
import { rateLimitWaitMs } from "../../lib/ratelimit";
import { useVisible } from "../../lib/useVisible";
import { qk } from "../../queries";

export const THREAD_POLL_MS = 5_000;
/** Every Nth poll re-reads the newest page so hide/unhide on recent messages lands. */
const FULL_REFRESH_EVERY = 12;
/** Automatic resends of one message after a 429, before it shows as failed. */
const AUTO_RESENDS = 3;

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
  /** why it has not gone yet; while sending, a 429 the thread will wait out */
  error?: string;
}

type InboxCache = { conversations: { id: string; unread: number; mentioned: boolean }[] } | undefined;

export function useThread(convId: string) {
  const qc = useQueryClient();
  const visible = useVisible();
  const key = qk.messages(convId);

  const page = useQuery({
    queryKey: key,
    queryFn: () => api.messages(convId),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  const [pending, setPending] = useState<PendingMessage[]>([]);
  const [pollError, setPollError] = useState<unknown>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  // Held sends after a 429: the timer that sends again, and how many times it has.
  const resendTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const resends = useRef(new Map<string, number>());
  const sendRef = useRef<((draft: Draft, clientMsgId: string) => Promise<void>) | undefined>(undefined);
  useEffect(() => {
    const timers = resendTimers.current;
    return () => {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    };
  }, [convId]);
  const cancelResend = useCallback((clientMsgId: string) => {
    const t = resendTimers.current.get(clientMsgId);
    if (t !== undefined) clearTimeout(t);
    resendTimers.current.delete(clientMsgId);
  }, []);

  const merge = useCallback(
    (incoming: PortalMessage[]) => {
      qc.setQueryData<MessagesResponse>(qk.messages(convId), (old) =>
        old ? { ...old, messages: mergeMessages(old.messages, incoming) } : { messages: mergeMessages([], incoming) },
      );
    },
    [qc, convId],
  );

  const poll = useCallback(
    async (full = false) => {
      const cur = qc.getQueryData<MessagesResponse>(qk.messages(convId));
      if (!cur) return;
      const after = lastId(cur.messages);
      const res = await api.messages(convId, full || !after ? {} : { after });
      merge(res.messages);
    },
    [qc, convId, merge],
  );

  const ready = page.data !== undefined;
  useEffect(() => {
    if (!visible || !ready) return;
    let tick = 0;
    let busy = false;
    const run = async () => {
      if (busy || document.hidden) return;
      busy = true;
      try {
        await poll(tick > 0 && tick % FULL_REFRESH_EVERY === 0);
        setPollError(null);
      } catch (err) {
        setPollError(err);
      } finally {
        tick++;
        busy = false;
      }
    };
    // Catch up at once when the thread opens or the tab comes back.
    void run();
    const timer = window.setInterval(() => void run(), THREAD_POLL_MS);
    return () => window.clearInterval(timer);
  }, [visible, ready, poll]);

  const loadOlder = useCallback(async () => {
    const cur = qc.getQueryData<MessagesResponse>(qk.messages(convId));
    if (!cur?.before || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const res = await api.messages(convId, { before: cur.before });
      qc.setQueryData<MessagesResponse>(qk.messages(convId), (old) => ({
        messages: mergeMessages(old?.messages ?? [], res.messages),
        ...(res.before ? { before: res.before } : {}),
      }));
    } catch (err) {
      setPollError(err);
    } finally {
      setLoadingOlder(false);
    }
  }, [qc, convId, loadingOlder]);

  /** Send a draft; a retry passes the failed message back with its clientMsgId. */
  const send = useCallback(
    async (draft: Draft, clientMsgId: string = newClientMsgId()) => {
      cancelResend(clientMsgId);
      const at = new Date().toISOString();
      const { body, mentions, important } = draft;
      setPending((list) => [
        ...list.filter((p) => p.clientMsgId !== clientMsgId),
        { clientMsgId, body, mentions, important, at, state: "sending" },
      ]);
      try {
        const result = await api.sendMessage(convId, { clientMsgId, body, mentions, important });
        if (!result.duplicate) merge([result.message]);
        else await poll();
        resends.current.delete(clientMsgId);
        setPending((list) => list.filter((p) => p.clientMsgId !== clientMsgId));
        void qc.invalidateQueries({ queryKey: qk.inbox });
      } catch (err) {
        const waitMs = rateLimitWaitMs(err);
        const tries = resends.current.get(clientMsgId) ?? 0;
        if (waitMs !== undefined && tries < AUTO_RESENDS) {
          // Refused before it was stored: hold it and send the same clientMsgId again.
          resends.current.set(clientMsgId, tries + 1);
          resendTimers.current.set(
            clientMsgId,
            setTimeout(() => {
              resendTimers.current.delete(clientMsgId);
              void sendRef.current?.(draft, clientMsgId);
            }, waitMs),
          );
          setPending((list) =>
            list.map((p) => (p.clientMsgId === clientMsgId ? { ...p, state: "sending", error: errorText(err) } : p)),
          );
          return;
        }
        resends.current.delete(clientMsgId);
        setPending((list) =>
          list.map((p) => (p.clientMsgId === clientMsgId ? { ...p, state: "failed", error: errorText(err) } : p)),
        );
      }
    },
    [convId, merge, poll, qc, cancelResend],
  );
  sendRef.current = send;

  const discard = useCallback((clientMsgId: string) => {
    cancelResend(clientMsgId);
    resends.current.delete(clientMsgId);
    setPending((list) => list.filter((p) => p.clientMsgId !== clientMsgId));
  }, [cancelResend]);

  const setHiddenLocal = useCallback(
    (messageId: string, hidden: boolean) => {
      qc.setQueryData<MessagesResponse>(qk.messages(convId), (old) =>
        old ? { ...old, messages: old.messages.map((m) => (m.id === messageId ? { ...m, hidden } : m)) } : old,
      );
    },
    [qc, convId],
  );

  // Read marker: move it to the newest message while the thread is open and visible.
  const messages = page.data?.messages ?? [];
  // Past the last message shown too: a count must clear even when nothing is left to show.
  const newest = Math.max(newestSeq(messages), page.data?.lastSeq ?? 0);
  const marked = useRef(0);
  useEffect(() => {
    if (!visible || newest === 0 || newest <= marked.current) return;
    const seq = newest;
    marked.current = seq;
    api
      .markRead(convId, seq)
      .then(() => {
        qc.setQueryData(qk.inbox, (old: InboxCache) =>
          old ? { ...old, conversations: old.conversations.map((c) => (c.id === convId ? { ...c, unread: 0, mentioned: false } : c)) } : old,
        );
        void qc.invalidateQueries({ queryKey: qk.me });
      })
      .catch(() => {
        // Try again on the next new message or visibility change.
        if (marked.current === seq) marked.current = 0;
      });
  }, [visible, newest, convId, qc]);

  return {
    messages,
    before: page.data?.before,
    isPending: page.isPending,
    error: page.error,
    refetch: page.refetch,
    pollError,
    pending,
    loadingOlder,
    loadOlder,
    send,
    discard,
    setHiddenLocal,
  };
}
