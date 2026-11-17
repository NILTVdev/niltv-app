/**
 * One open thread's messages: the newest page, older pages on demand, the
 * 5 s delta poll (?after=) while the tab is visible, optimistic sends with
 * retry on the same clientMsgId, and the read marker. Unsent messages live in
 * lib/outbox.ts, so they survive leaving the thread; a send that fails while
 * its thread is off screen raises a toast.
 */
import type { MessagesResponse, PortalMessage } from "@niltv/types";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, errorText } from "../../api";
import { lastId, mergeMessages, newClientMsgId, newestSeq } from "../../lib/messages";
import { rateLimitWaitMs } from "../../lib/ratelimit";
import {
  type Draft,
  discardPending,
  failedNotice,
  forgetResend,
  holdForResend,
  isOnScreen,
  markFailed,
  outboxEpoch,
  pendingFor,
  removePending,
  showThread,
  updatePending,
  upsertPending,
  usePending,
} from "../../lib/outbox";
import { useVisible } from "../../lib/useVisible";
import { qk } from "../../queries";
import { useToast } from "../../ui/Toast";

export type { Draft, PendingMessage } from "../../lib/outbox";

export const THREAD_POLL_MS = 5_000;
/** Every Nth poll re-reads the newest page so hide/unhide on recent messages lands. */
const FULL_REFRESH_EVERY = 12;
/** Automatic resends of one message after a 429, before it shows as failed. */
const AUTO_RESENDS = 3;

type InboxCache = { conversations: { id: string; unread: number; mentioned: boolean }[] } | undefined;

/** `title` names the thread in the toast when a send fails after you leave it. */
export function useThread(convId: string, title?: string) {
  const qc = useQueryClient();
  const toast = useToast();
  const visible = useVisible();
  const key = qk.messages(convId);
  const titleRef = useRef(title);
  titleRef.current = title;

  useEffect(() => showThread(convId), [convId]);

  const page = useQuery({
    queryKey: key,
    queryFn: () => api.messages(convId),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  const pending = usePending(convId);
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

  /** Send a draft; a retry passes the failed message back with its clientMsgId. */
  const send = useCallback(
    (draft: Draft, clientMsgId: string = newClientMsgId()): Promise<void> => {
      const { body, mentions, important } = draft;
      // The thread may be closed by the time this settles: everything below
      // goes to the outbox and the query cache, never to component state.
      const sendTitle = titleRef.current;
      const stillListed = () => pendingFor(convId).some((p) => p.clientMsgId === clientMsgId);

      // One try. `epoch` is fixed when the member pressed Send, so a held
      // resend after a sign-out sees a new epoch and does nothing.
      const attempt = async (epoch: number): Promise<void> => {
        const signedOut = () => outboxEpoch() !== epoch;
        if (signedOut()) return;
        const at = new Date().toISOString();
        updatePending(convId, (list) =>
          upsertPending(list, { clientMsgId, body, mentions, important, at, state: "sending" }),
        );
        let sent = false;
        try {
          const result = await api.sendMessage(convId, { clientMsgId, body, mentions, important });
          if (signedOut()) return;
          sent = true;
          if (!result.duplicate) merge([result.message]);
          else await poll();
        } catch (err) {
          if (signedOut()) return;
          if (!sent) {
            const waitMs = rateLimitWaitMs(err);
            if (waitMs !== undefined) {
              // Refused before it was stored: hold it and send the same clientMsgId again.
              const hold = holdForResend(convId, clientMsgId, {
                waitMs,
                epoch,
                max: AUTO_RESENDS,
                resend: () => void attempt(epoch),
              });
              if (hold === "gone") return;
              if (hold === "held") {
                updatePending(convId, (list) =>
                  list.map((p) => (p.clientMsgId === clientMsgId ? { ...p, state: "sending", error: errorText(err) } : p)),
                );
                return;
              }
            }
            forgetResend(convId, clientMsgId);
            if (!stillListed()) return;
            updatePending(convId, (list) => markFailed(list, clientMsgId, errorText(err)));
            if (!isOnScreen(convId)) toast(failedNotice(sendTitle), "bad");
            return;
          }
        }
        if (signedOut()) return;
        forgetResend(convId, clientMsgId);
        updatePending(convId, (list) => removePending(list, clientMsgId));
        void qc.invalidateQueries({ queryKey: qk.inbox });
      };

      // A send from the screen starts over: any held resend and its count go.
      forgetResend(convId, clientMsgId);
      return attempt(outboxEpoch());
    },
    [convId, merge, poll, qc, toast],
  );

  const discard = useCallback((clientMsgId: string) => discardPending(convId, clientMsgId), [convId]);

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
