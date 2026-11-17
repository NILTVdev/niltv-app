/**
 * Messages: channels, groups and desk threads on the left, the open thread
 * on the right. On phones the list and the thread swap. The inbox polls
 * every 20 s while the tab is visible; the open thread every 5 s. An "@"
 * next to the count means an unread message mentions you.
 */
import { type ChannelScope, type ConversationSummary, DESK_LABELS, type Desk, desksFor, isStaffRole } from "@niltv/types";
import { Fragment, useState } from "react";
import { errorText } from "../api";
import { plural, ROLE_LABELS } from "../lib/format";
import { hasFailed, useOutboxVersion } from "../lib/outbox";
import { go, pathFor } from "../lib/router";
import type { ScreenProps } from "../Portal";
import { useInbox, useOpenDesk } from "../queries";
import { Avatar, ErrorNote, Loading, PageHead } from "../ui/bits";
import { Link } from "../ui/Link";
import { useMe } from "../ui/me";
import { GroupForm } from "./messages/GroupForm";
import { NewDeskMessage } from "./messages/NewDeskMessage";
import { Thread } from "./messages/Thread";

const SCOPE_ORDER: Record<ChannelScope["type"], number> = { announcements: 0, everyone: 1, campus: 2, sport: 3 };

function channelSort(a: ConversationSummary, b: ConversationSummary): number {
  const sa = a.scope ? SCOPE_ORDER[a.scope.type] : 9;
  const sb = b.scope ? SCOPE_ORDER[b.scope.type] : 9;
  return sa - sb || a.title.localeCompare(b.title);
}

type Panel = { kind: "new-message" } | { kind: "new-group" } | { kind: "edit-group"; id: string } | null;

export function Messages({ id }: ScreenProps) {
  const { member, can } = useMe();
  const staff = isStaffRole(member.role);
  const inbox = useInbox(true);
  // Threads with a failed send say so in the list.
  useOutboxVersion();
  const openDesk = useOpenDesk();
  const [panel, setPanel] = useState<Panel>(null);

  const all = inbox.data ?? [];
  const channels = all.filter((c) => c.kind === "channel").sort(channelSort);
  const groups = all.filter((c) => c.kind === "group").sort((a, b) => a.title.localeCompare(b.title));
  const desks = all
    .filter((c) => c.kind === "desk")
    .sort((a, b) => (b.lastMessageAt ?? "").localeCompare(a.lastMessageAt ?? ""));
  const current = id ? all.find((c) => c.id === id) : undefined;

  // Athletes and guests: every desk they may write to. An existing thread
  // opens directly; otherwise POST /v1/desks creates it.
  const deskThread = new Map(desks.map((d) => [d.desk, d.id]));
  const startable: Desk[] = staff ? [] : desksFor(member.role);
  const messageDesk = (d: Desk) => {
    const existing = deskThread.get(d);
    if (existing) go("messages", existing);
    else openDesk.mutate({ desk: d });
  };

  const sub =
    member.role === "athlete"
      ? "Talk with the NIL TV team, your campus, your sport and every athlete in the network."
      : member.role === "guest"
        ? "Your groups and your messages with the NIL TV team."
        : undefined;
  const access =
    member.role === "athlete"
      ? "Your desks and channels"
      : member.role === "guest"
        ? "Only the groups you are in"
        : "Staff and admins";

  const item = (c: ConversationSummary) => {
    const unread = c.unread > 0 && !c.muted;
    const icon =
      c.kind === "desk" ? (
        staff && c.person ? (
          <Avatar name={c.person.name} role={c.person.role} />
        ) : (
          <Avatar name="NT" team />
        )
      ) : (
        <span className="hash" aria-hidden="true">
          #
        </span>
      );
    const line =
      c.lastPreview ??
      (c.kind === "channel"
        ? plural(c.memberCount, "member")
        : c.kind === "group"
          ? `${plural(c.memberCount, "person", "people")} plus staff`
          : staff && c.person && c.desk
            ? `${ROLE_LABELS[c.person.role]} to ${DESK_LABELS[c.desk]}`
            : "NIL TV staff");
    return (
      <Link
        key={c.id}
        to={pathFor("messages", c.id)}
        className={`thread${unread ? " unread" : ""}`}
        aria-current={c.id === id ? "true" : undefined}
      >
        {icon}
        <span className="txt">
          <span className="nm">{c.title}</span>
          <span className="sub">
            {staff && c.kind === "desk" && c.desk ? `${DESK_LABELS[c.desk]} · ` : ""}
            {line}
          </span>
        </span>
        {c.muted ? <span className="muteicon">Muted</span> : null}
        {hasFailed(c.id) ? <span className="muteicon">Not sent</span> : null}
        {c.mentioned ? (
          <span className="at" title="Mentions you">
            <span aria-hidden="true">@</span>
            <span className="sr-only">Mentions you,</span>
          </span>
        ) : null}
        {unread ? (
          <span className="dot">
            {c.unread > 99 ? "99+" : c.unread}
            <span className="sr-only"> unread</span>
          </span>
        ) : null}
      </Link>
    );
  };

  const section = (title: string, list: ConversationSummary[]) =>
    list.length ? (
      <Fragment key={title}>
        <h2 className="grp">{title}</h2>
        {list.map(item)}
      </Fragment>
    ) : null;

  return (
    <>
      <PageHead title="Messages" sub={sub} access={access} />
      {staff ? (
        <div className="row">
          {can("answerDesks") ? (
            <button type="button" className="btn" onClick={() => setPanel({ kind: "new-message" })}>
              New message
            </button>
          ) : null}
          {can("manageGroups") ? (
            <button type="button" className="btn ghost" onClick={() => setPanel({ kind: "new-group" })}>
              New group
            </button>
          ) : null}
        </div>
      ) : null}
      {panel?.kind === "new-message" ? <NewDeskMessage onDone={() => setPanel(null)} /> : null}
      {panel?.kind === "new-group" ? <GroupForm onDone={() => setPanel(null)} /> : null}
      {panel?.kind === "edit-group" ? <GroupForm key={panel.id} editId={panel.id} onDone={() => setPanel(null)} /> : null}
      <ErrorNote error={inbox.error} onRetry={() => void inbox.refetch()} />
      <div className={`chat${id ? " show-convo" : ""}`}>
        <nav className="threads" aria-label="Conversations">
          {inbox.isPending ? <Loading what="Loading conversations" /> : null}
          {section("Channels", channels)}
          {section("Groups", groups)}
          {section("Desks", desks)}
          {startable.length ? (
            <div className="deskstart">
              <span className="lbl">Message a desk</span>
              {startable.map((d) => (
                <button
                  key={d}
                  type="button"
                  className="btn ghost sm"
                  disabled={openDesk.isPending}
                  onClick={() => messageDesk(d)}
                >
                  {DESK_LABELS[d]}
                </button>
              ))}
              {openDesk.error ? (
                <span className="err" role="alert">
                  {errorText(openDesk.error)}
                </span>
              ) : null}
            </div>
          ) : null}
          {!inbox.isPending && all.length === 0 && startable.length === 0 ? (
            <p className="muted" style={{ padding: "8px 10px" }}>
              No conversations yet.
            </p>
          ) : null}
        </nav>
        <section className="convo" aria-label="Conversation">
          {id ? (
            <Thread
              key={id}
              convId={id}
              summary={current}
              onEditGroup={(groupId) => {
                setPanel({ kind: "edit-group", id: groupId });
                window.scrollTo({ top: 0 });
              }}
            />
          ) : (
            <div className="convo-empty">Pick a conversation.</div>
          )}
        </section>
      </div>
    </>
  );
}
