/** Home: what needs you now. Athletes and staff see different lists. */
import { DESK_LABELS, EVENT_KIND_LABELS, type PortalEvent } from "@niltv/types";
import { lockedOption, unansweredPolls, upcomingSet } from "../lib/events";
import { firstName, plural } from "../lib/format";
import { pathFor } from "../lib/router";
import { formatRange } from "../lib/time";
import { useEvents, useInbox, useMembers, usePostings, useRequests } from "../queries";
import { Empty, ErrorNote, Loading, PageHead } from "../ui/bits";
import { Link } from "../ui/Link";
import { useMe } from "../ui/me";

export function Home() {
  const { member } = useMe();
  return member.role === "athlete" ? <AthleteHome /> : <StaffHome />;
}

function Attn({ to, label, text, tone }: { to: string; label?: string; text: string; tone?: "wait" | "info" }) {
  return (
    <Link className="attn" to={to}>
      <span className={`dotc${tone ? ` ${tone}` : ""}`} aria-hidden="true" />
      <span className="txt">
        {label ? <span className="k">{label}</span> : null}
        <span className="v">{text}</span>
      </span>
      <span className="chev" aria-hidden="true">
        ›
      </span>
    </Link>
  );
}

function CountRow({ to, text, n }: { to: string; text: string; n: number }) {
  return (
    <Link className="attn" to={to}>
      <span className={`dotc${n ? "" : " wait"}`} aria-hidden="true" />
      <span className="txt">
        <span className="v">{text}</span>
      </span>
      <span className={`badge${n ? " hot" : ""}`}>{n}</span>
    </Link>
  );
}

function EventLine({ e }: { e: PortalEvent }) {
  const { zone } = useMe();
  const t = lockedOption(e);
  return (
    <Link className="mini" to={pathFor("schedule", e.id)}>
      <span>
        <span className="t">{e.title}</span>
        <br />
        <span className="meta">
          {t ? formatRange(t.startsAt, t.endsAt, zone) : ""} · {e.audienceLabel}
        </span>
      </span>
      <span className="fmt">{EVENT_KIND_LABELS[e.kind]}</span>
    </Link>
  );
}

function AthleteHome() {
  const { member, unread, zone } = useMe();
  const events = useEvents();
  const postings = usePostings();

  const all = events.data ?? [];
  const polls = unansweredPolls(all);
  const upcoming = upcomingSet(all);
  const needRsvp = upcoming.filter((e) => !e.myRsvp);
  const open = (postings.data ?? []).filter((p) => p.status === "open");
  const next = upcoming.slice(0, 3);

  const items = [
    ...polls.map((e) => (
      <Attn key={`p-${e.id}`} to={pathFor("schedule", e.id)} label="Pick times that work" text={e.title} />
    )),
    ...needRsvp.map((e) => {
      const t = lockedOption(e);
      return (
        <Attn
          key={`r-${e.id}`}
          to={pathFor("schedule", e.id)}
          label="RSVP"
          text={t ? `${e.title}, ${formatRange(t.startsAt, t.endsAt, zone)}` : e.title}
        />
      );
    }),
    ...(unread > 0
      ? [<Attn key="m" to={pathFor("messages")} label="Messages" text={plural(unread, "unread message")} tone="info" />]
      : []),
  ];

  return (
    <>
      <PageHead title={`Hi, ${firstName(member.name)}`} sub="Here is what needs you today." />
      <section className="stack" aria-labelledby="needs-you">
        <div className="bar">
          <h2 id="needs-you">Needs you</h2>
        </div>
        {events.isPending ? <Loading /> : null}
        <ErrorNote error={events.error} onRetry={() => void events.refetch()} />
        {!events.isPending && items.length === 0 ? <Empty>You are all caught up.</Empty> : items}
      </section>
      <div className="split">
        <section className="panel stack" aria-labelledby="coming-up">
          <div className="bar">
            <h3 id="coming-up">Coming up</h3>
            <Link className="linkbtn" to={pathFor("schedule")}>
              Schedule
            </Link>
          </div>
          {next.length ? (
            <div>
              {next.map((e) => (
                <EventLine key={e.id} e={e} />
              ))}
            </div>
          ) : (
            <p className="note">Nothing scheduled for you yet.</p>
          )}
        </section>
        <div className="stack">
          <section className="panel stack" aria-labelledby="postings-h">
            <div className="bar">
              <h3 id="postings-h">Internal Postings</h3>
              <Link className="linkbtn" to={pathFor("postings")}>
                See all
              </Link>
            </div>
            <ErrorNote error={postings.error} />
            <p className="note">
              {postings.isPending
                ? "Loading…"
                : open.length
                  ? `${plural(open.length, "open posting")}. Mark interest and the team reaches out.`
                  : "No open postings right now."}
            </p>
          </section>
          <section className="panel stack" aria-labelledby="links-h">
            <h3 id="links-h">Quick links</h3>
            <div className="links">
              <Link className="btn ghost" to={pathFor("hub")}>
                Content Hub
              </Link>
              <Link className="btn ghost" to={pathFor("posts")}>
                My posts
              </Link>
              <Link className="btn ghost" to={pathFor("page")}>
                My athlete page
              </Link>
              <Link className="btn ghost" to={pathFor("payments")}>
                Payments
              </Link>
              <Link className="btn ghost" to={pathFor("help")}>
                Help
              </Link>
            </div>
          </section>
        </div>
      </div>
    </>
  );
}

function StaffHome() {
  const { member, unread, can } = useMe();
  const admin = can("manageAccess");
  const inbox = useInbox();
  const events = useEvents();
  const requests = useRequests(can("manageRequests"));
  const members = useMembers(admin);

  const deskUnread = (inbox.data ?? []).filter((c) => c.kind === "desk" && c.unread > 0);
  const polls = (events.data ?? []).filter((e) => e.status === "poll");
  const upcoming = upcomingSet(events.data ?? []).slice(0, 5);
  const openRequests = (requests.data ?? []).filter((r) => r.status === "open").length;
  const ready = (members.data ?? []).filter((m) => m.role === "athlete" && m.status === "ready").length;

  return (
    <>
      <PageHead
        title={`Hi, ${firstName(member.name)}`}
        access={admin ? "Admins" : "Staff and admins"}
      />
      <ErrorNote error={inbox.error ?? events.error ?? requests.error ?? members.error} />
      <section className="stack" aria-labelledby="desk-h">
        <div className="bar">
          <h2 id="desk-h">Desk threads</h2>
          <Link className="linkbtn" to={pathFor("messages")}>
            Messages
          </Link>
        </div>
        {inbox.isPending ? <Loading /> : null}
        {!inbox.isPending && deskUnread.length === 0 ? <Empty>No unread desk threads.</Empty> : null}
        {deskUnread.map((c) => (
          <Attn
            key={c.id}
            to={pathFor("messages", c.id)}
            label={`${c.desk ? `${DESK_LABELS[c.desk]} · ` : ""}${plural(c.unread, "unread message")}`}
            text={c.lastPreview ? `${c.title}: ${c.lastPreview}` : c.title}
          />
        ))}
      </section>
      <section className="stack" aria-label="Counts">
        <CountRow to={pathFor("messages")} text="Unread messages" n={unread} />
        <CountRow to={pathFor("schedule")} text="Time polls ready to lock" n={polls.length} />
        {can("manageRequests") ? <CountRow to={pathFor("requests")} text="Open page change requests" n={openRequests} /> : null}
        {admin ? <CountRow to={pathFor("athletes")} text="Athletes waiting for access" n={ready} /> : null}
      </section>
      <section className="panel" aria-labelledby="upcoming-h">
        <div className="bar">
          <h3 id="upcoming-h">Coming up</h3>
          <Link className="linkbtn" to={pathFor("schedule")}>
            Schedule
          </Link>
        </div>
        {events.isPending ? <Loading /> : null}
        {upcoming.length ? (
          upcoming.map((e) => <EventLine key={e.id} e={e} />)
        ) : !events.isPending ? (
          <p className="note">Nothing set yet.</p>
        ) : null}
      </section>
    </>
  );
}
