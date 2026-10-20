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
import { useVisible } from "../../lib/useVisible";
import { qk } from "../../queries";

export const THREAD_POLL_MS = 5_000;
/** Every Nth poll re-reads the newest page so hide/unhide on recent messages lands. */
const FULL_REFRESH_EVERY = 12;

export interface PendingMessage {
  clientMsgId: string;
  body: string;
  at: string;
  state: "sending" | "failed";
  error?: string;
}

type InboxCache = { conversations: { id: string; unread: number }[] } | undefined;

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

  const send = useCallback(
    async (body: string, clientMsgId: string = newClientMsgId()) => {
      const at = new Date().toISOString();
      setPending((list) => [
        ...list.filter((p) => p.clientMsgId !== clientMsgId),
        { clientMsgId, body, at, state: "sending" },
      ]);
      try {
        const result = await api.sendMessage(convId, { clientMsgId, body });
        if (!result.duplicate) merge([result.message]);
        else await poll();
        setPending((list) => list.filter((p) => p.clientMsgId !== clientMsgId));
        void qc.invalidateQueries({ queryKey: qk.inbox });
      } catch (err) {
        setPending((list) =>
          list.map((p) => (p.clientMsgId === clientMsgId ? { ...p, state: "failed", error: errorText(err) } : p)),
        );
      }
    },
    [convId, merge, poll, qc],
  );

  const discard = useCallback((clientMsgId: string) => {
    setPending((list) => list.filter((p) => p.clientMsgId !== clientMsgId));
  }, []);

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
  const newest = newestSeq(messages);
  const marked = useRef(0);
  useEffect(() => {
    if (!visible || newest === 0 || newest <= marked.current) return;
    const seq = newest;
    marked.current = seq;
    api
      .markRead(convId, seq)
      .then(() => {
        qc.setQueryData(qk.inbox, (old: InboxCache) =>
          old ? { ...old, conversations: old.conversations.map((c) => (c.id === convId ? { ...c, unread: 0 } : c)) } : old,
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
