/** One open conversation: header, info panel, messages, composer. */
import {
  type ConversationDetail,
  type ConversationSummary,
  DESK_LABELS,
  type PortalMessage,
  isStaffRole,
} from "@niltv/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, type KeyboardEvent, useLayoutEffect, useRef, useState } from "react";
import { api, errorText, isApiError } from "../../api";
import { plural, ROLE_LABELS } from "../../lib/format";
import { pathFor } from "../../lib/router";
import { formatDateTime, formatMessageTime } from "../../lib/time";
import { qk } from "../../queries";
import { Avatar, ErrorNote, Loading } from "../../ui/bits";
import { Icon } from "../../ui/Icon";
import { Link } from "../../ui/Link";
import { useMe } from "../../ui/me";
import { useToast } from "../../ui/Toast";
import { type PendingMessage, useThread } from "./useThread";

type Conv = ConversationSummary | ConversationDetail;

export function Thread({
  convId,
  summary,
  onEditGroup,
}: {
  convId: string;
  summary: ConversationSummary | undefined;
  onEditGroup: (convId: string) => void;
}) {
  const { member, can } = useMe();
  const staff = isStaffRole(member.role);
  const qc = useQueryClient();
  const toast = useToast();
  const detail = useQuery({ queryKey: qk.conv(convId), queryFn: () => api.conversation(convId) });
  const thread = useThread(convId);
  const [infoOpen, setInfoOpen] = useState(false);

  const conv: Conv | undefined = detail.data ?? summary;

  const mute = useMutation({
    mutationFn: (muted: boolean) => api.mute(convId, muted),
    onSuccess: (_, muted) => {
      qc.setQueryData<ConversationDetail>(qk.conv(convId), (old) => (old ? { ...old, muted } : old));
      void qc.invalidateQueries({ queryKey: qk.inbox });
      void qc.invalidateQueries({ queryKey: qk.me });
      toast(muted ? "Muted. It no longer counts toward your unread badge." : "Unmuted.");
    },
    onError: (err) => toast(errorText(err), "bad"),
  });

  const hide = useMutation({
    mutationFn: (v: { id: string; hidden: boolean }) => api.hideMessage(convId, v.id, v.hidden),
    onSuccess: (_, v) => {
      thread.setHiddenLocal(v.id, v.hidden);
      toast(v.hidden ? "Hidden. Members see that staff removed it." : "Unhidden.");
    },
    onError: (err) => toast(errorText(err), "bad"),
  });

  if (!conv) {
    if (detail.isPending) return <div className="convo-empty"><Loading /></div>;
    const gone = isApiError(detail.error, "NOT_FOUND");
    return (
      <div className="convo-empty">
        <div className="stack" style={{ alignItems: "center" }}>
          {gone ? <p>This conversation is not available.</p> : <ErrorNote error={detail.error} onRetry={() => void detail.refetch()} />}
          <Link className="btn ghost" to={pathFor("messages")}>
            Back to conversations
          </Link>
        </div>
      </div>
    );
  }

  const channelish = conv.kind === "channel" || conv.kind === "group";
  const canPost = staff || !conv.staffOnly;
  const muted = detail.data?.muted ?? conv.muted;
  const members = detail.data?.members ?? [];

  let hint: string | undefined;
  if (staff && conv.kind === "channel") hint = `Posts as NIL TV Team to ${plural(conv.memberCount, "member")}.`;
  if (staff && conv.kind === "group") hint = "Posts as NIL TV Team.";
  if (staff && conv.kind === "desk" && conv.desk) hint = `Replies as ${DESK_LABELS[conv.desk]}.`;
  const placeholder = conv.kind === "desk" ? `Message ${conv.title}` : `Message #${conv.title}`;

  return (
    <>
      <div className="convo-head">
        <Link className="back" to={pathFor("messages")} aria-label="Back to conversations">
          <Icon name="back" size={20} />
        </Link>
        <div className="ttl">
          <h2>
            {channelish ? "#" : ""}
            {conv.title}
          </h2>
          <p>{conv.about}</p>
        </div>
        <div className="row">
          {staff && conv.kind === "desk" && conv.person ? (
            <Link className="btn ghost sm" to={pathFor(conv.person.role === "guest" ? "guests" : "athletes")}>
              View {conv.person.role === "guest" ? "guests" : "athletes"}
            </Link>
          ) : null}
          {conv.kind === "group" && can("manageGroups") ? (
            <button type="button" className="btn ghost sm" onClick={() => onEditGroup(convId)}>
              Edit group
            </button>
          ) : null}
          <button
            type="button"
            className="btn ghost sm"
            aria-pressed={muted}
            disabled={mute.isPending}
            onClick={() => mute.mutate(!muted)}
          >
            {muted ? "Unmute" : "Mute"}
          </button>
          <button
            type="button"
            className="btn ghost sm"
            aria-expanded={infoOpen}
            aria-controls={`info-${convId}`}
            onClick={() => setInfoOpen((o) => !o)}
          >
            Info
          </button>
        </div>
      </div>
      <div>
        {infoOpen ? (
          <div className="info" id={`info-${convId}`}>
            <p className="note">{conv.about || "No description."}</p>
            {conv.kind === "channel" ? (
              <p className="meta">
                {plural(conv.memberCount, "member")}. Staff see and post in every channel.
                {conv.staffOnly ? " Only staff post here." : ""}
              </p>
            ) : (
              <>
                <p className="meta">
                  {conv.kind === "group"
                    ? `${plural(members.length, "person", "people")} plus staff.`
                    : "Private. Everyone on this desk can read and reply."}
                </p>
                {detail.isPending ? <Loading what="Loading members" /> : null}
                {members.length ? (
                  <ul aria-label="Members">
                    {members.map((p) => (
                      <li key={p.sub}>
                        {p.name} <span className="muted">{ROLE_LABELS[p.role]}</span>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </>
            )}
          </div>
        ) : null}
      </div>
      <MessageList
        thread={thread}
        staffViewer={staff}
        onToggleHide={(m) => hide.mutate({ id: m.id, hidden: !m.hidden })}
        hidePending={hide.isPending}
      />
      <Composer
        key={convId}
        placeholder={canPost ? placeholder : "Only staff post here"}
        hint={hint}
        lockedNote={canPost ? undefined : `Only staff post in ${conv.title}.`}
        onSend={(body) => void thread.send(body)}
      />
    </>
  );
}

function MessageList({
  thread,
  staffViewer,
  onToggleHide,
  hidePending,
}: {
  thread: ReturnType<typeof useThread>;
  staffViewer: boolean;
  onToggleHide: (m: PortalMessage) => void;
  hidePending: boolean;
}) {
  const { zone } = useMe();
  const ref = useRef<HTMLDivElement>(null);
  const snap = useRef<{ first?: string; last?: string; nearBottom: boolean; fromBottom: number }>({
    nearBottom: true,
    fromBottom: 0,
  });

  const { messages, pending } = thread;
  const first = messages[0]?.id;
  const last = `${messages[messages.length - 1]?.id ?? ""}:${pending.length}`;
  const lastMine = pending.length > 0 || messages[messages.length - 1]?.mine === true;

  // Keep the view pinned: jump to the bottom on open and on new messages
  // (when already near it, or when it is your own); hold position when an
  // older page lands on top.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const s = snap.current;
    if (s.first && first !== s.first && s.last === last) {
      el.scrollTop = el.scrollHeight - s.fromBottom;
    } else if (last !== s.last && (s.last === undefined || s.nearBottom || lastMine)) {
      el.scrollTop = el.scrollHeight;
    }
    s.first = first;
    s.last = last;
    s.fromBottom = el.scrollHeight - el.scrollTop;
    s.nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  });

  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    snap.current.fromBottom = el.scrollHeight - el.scrollTop;
    snap.current.nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  };

  return (
    <div className="msgs" ref={ref} onScroll={onScroll} role="log" aria-label="Messages" aria-live="polite" aria-relevant="additions">
      {thread.isPending ? <Loading what="Loading messages" /> : null}
      <ErrorNote error={thread.error} onRetry={() => void thread.refetch()} />
      {thread.before ? (
        <button type="button" className="btn ghost sm older" disabled={thread.loadingOlder} onClick={() => void thread.loadOlder()}>
          {thread.loadingOlder ? "Loading…" : "Load older messages"}
        </button>
      ) : null}
      {!thread.isPending && !thread.error && messages.length === 0 && pending.length === 0 ? (
        <p className="muted">No messages yet. Start the conversation.</p>
      ) : null}
      {messages.map((m) => (
        <MessageRow
          key={m.id}
          m={m}
          zone={zone}
          staffViewer={staffViewer}
          onToggleHide={onToggleHide}
          hidePending={hidePending}
        />
      ))}
      {pending.map((p) => (
        <PendingRow key={p.clientMsgId} p={p} thread={thread} />
      ))}
      {thread.pollError ? <p className="meta">Could not refresh: {errorText(thread.pollError)} Trying again.</p> : null}
    </div>
  );
}

function MessageRow({
  m,
  zone,
  staffViewer,
  onToggleHide,
  hidePending,
}: {
  m: PortalMessage;
  zone: string;
  staffViewer: boolean;
  onToggleHide: (m: PortalMessage) => void;
  hidePending: boolean;
}) {
  const staffAuthor = isStaffRole(m.authorRole);
  return (
    <div className={`msg${m.hidden ? " is-hidden" : ""}`}>
      <Avatar name={m.authorName} role={m.authorRole} />
      <div className="body">
        <div className="who">
          <span>{m.authorName}</span>
          {staffAuthor ? <span className="tag">Staff</span> : m.authorRole === "guest" ? <span className="tag guest">Guest</span> : null}
          {staffViewer && m.staffName ? <span className="by">by {m.staffName}</span> : null}
          <time className="when" dateTime={m.at} title={formatDateTime(m.at, zone)}>
            {formatMessageTime(m.at, zone)}
          </time>
          {staffViewer ? (
            <button type="button" className="linkbtn" disabled={hidePending} onClick={() => onToggleHide(m)}>
              {m.hidden ? "Unhide" : "Hide"}
            </button>
          ) : null}
        </div>
        {m.hidden && !staffViewer ? (
          <p className="hidden">Hidden by staff</p>
        ) : (
          <>
            <p className="body-text">{m.body}</p>
            {m.hidden ? <p className="meta">Hidden by staff. Members do not see this message.</p> : null}
          </>
        )}
      </div>
    </div>
  );
}

function PendingRow({ p, thread }: { p: PendingMessage; thread: ReturnType<typeof useThread> }) {
  const { member } = useMe();
  return (
    <div className="msg pending">
      <Avatar name={member.name} role={member.role} />
      <div className="body">
        <div className="who">
          <span>{isStaffRole(member.role) ? "You" : member.name}</span>
        </div>
        <p>{p.body}</p>
        {p.state === "sending" ? (
          <div className="state">Sending…</div>
        ) : (
          <div className="state failed" role="alert">
            Not sent. {p.error}
            <button type="button" className="linkbtn" onClick={() => void thread.send(p.body, p.clientMsgId)}>
              Retry
            </button>
            <button type="button" className="linkbtn" onClick={() => thread.discard(p.clientMsgId)}>
              Discard
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

const MAX_BODY = 4000;

function Composer({
  placeholder,
  hint,
  lockedNote,
  onSend,
}: {
  placeholder: string;
  hint?: string;
  /** set: the composer is disabled and this says why */
  lockedNote?: string;
  onSend: (body: string) => void;
}) {
  const [text, setText] = useState("");
  const body = text.trim();
  const tooLong = body.length > MAX_BODY;
  const locked = lockedNote !== undefined;

  const submit = () => {
    if (locked || !body || tooLong) return;
    onSend(body);
    setText("");
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="composer">
      <form
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          submit();
        }}
      >
        <label htmlFor="composer-input" className="sr-only">
          Message
        </label>
        <textarea
          id="composer-input"
          rows={Math.min(6, Math.max(1, text.split("\n").length))}
          value={text}
          placeholder={placeholder}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          aria-describedby="composer-hint"
          autoComplete="off"
          disabled={locked}
        />
        <button className="btn" type="submit" disabled={locked || !body || tooLong}>
          Send
        </button>
      </form>
      <span id="composer-hint" className="note">
        {locked ? (
          lockedNote
        ) : (
          <>
            {tooLong ? `Too long by ${body.length - MAX_BODY} characters. ` : ""}
            {hint ? `${hint} ` : ""}Enter sends. Shift+Enter adds a line.
          </>
        )}
      </span>
    </div>
  );
}
