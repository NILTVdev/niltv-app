/**
 * Content Hub: a static PREVIEW of asks and claims from the approved mockup.
 * Nothing here calls the API and every action is disabled until the
 * feature ships. Sample data has no real names.
 */
import { useState } from "react";
import { Empty, PageHead, Pill, Tabs } from "../ui/bits";
import { useMe } from "../ui/me";
import type { Tone } from "../lib/format";

type ClaimState = "requested" | "claimed" | "submitted" | "delivered" | "declined";

const CLAIM: Record<ClaimState, { label: string; tone: Tone }> = {
  requested: { label: "Waiting for approval", tone: "neutral" },
  claimed: { label: "Claimed", tone: "warn" },
  submitted: { label: "In review", tone: "info" },
  delivered: { label: "Delivered", tone: "ok" },
  declined: { label: "Not approved", tone: "bad" },
};

interface SampleAsk {
  id: number;
  title: string;
  format: "Short form" | "Long form";
  target: string;
  approval: boolean;
  posted: string;
  desc: string;
  mine?: ClaimState;
  claims: { who: string; status: ClaimState }[];
}

const ASKS: SampleAsk[] = [
  {
    id: 1,
    title: "Preseason prediction",
    format: "Short form",
    target: "Women's Basketball",
    approval: false,
    posted: "Oct 15",
    desc: "Give one bold prediction for your team this season. 20 to 30 seconds, vertical, talking to camera.",
    claims: [],
  },
  {
    id: 2,
    title: "Media day, behind the scenes",
    format: "Long form",
    target: "Women's Basketball",
    approval: true,
    posted: "Oct 14",
    desc: "Film the parts of media day nobody sees: the waiting around and the photo setups.\nPhone footage is perfect. Send 3 to 5 minutes of raw clips.",
    mine: "requested",
    claims: [{ who: "Athlete A", status: "requested" }],
  },
  {
    id: 3,
    title: "Rules of your sport, rapid fire",
    format: "Short form",
    target: "Every athlete",
    approval: false,
    posted: "Oct 13",
    desc: "Answer five rules questions about your sport on camera. We send the questions once you claim.\nVertical, 60 to 90 seconds.",
    claims: [
      { who: "Athlete B", status: "submitted" },
      { who: "Athlete C", status: "claimed" },
    ],
  },
  {
    id: 4,
    title: "Walk-in fit check",
    format: "Short form",
    target: "TrueBlue TV",
    approval: false,
    posted: "Oct 12",
    desc: "Home game. Ten seconds of your outfit on the way in. One take is fine.",
    mine: "claimed",
    claims: [{ who: "Athlete A", status: "claimed" }],
  },
  {
    id: 5,
    title: "Pitch a story for the podcast",
    format: "Long form",
    target: "Every athlete",
    approval: true,
    posted: "Oct 12",
    desc: "Record a voice memo or video pitching a story you would tell on the NIL TV podcast.",
    claims: [{ who: "Athlete D", status: "requested" }],
  },
  {
    id: 6,
    title: "Home opener hype clip",
    format: "Short form",
    target: "TrueBlue TV",
    approval: false,
    posted: "Sep 24",
    desc: "Locker room energy before the opener. Keep teammates who opt out off camera.",
    mine: "delivered",
    claims: [
      { who: "Athlete A", status: "delivered" },
      { who: "Athlete B", status: "delivered" },
    ],
  },
];

function PreviewBanner() {
  return (
    <div className="banner" role="note">
      <Pill tone="info">Preview</Pill>
      <span>Preview. Asks and claims are coming soon.</span>
    </div>
  );
}

function AskCard({ ask }: { ask: SampleAsk }) {
  return (
    <article className="card" aria-label={ask.title}>
      <div className="card-top">
        <span className="row tight">
          <span className={`fmt${ask.format === "Long form" ? " long" : ""}`}>{ask.format}</span>
          <span className="tgt">{ask.target}</span>
        </span>
        {ask.mine ? <Pill tone={CLAIM[ask.mine].tone}>{CLAIM[ask.mine].label}</Pill> : null}
      </div>
      <h3>{ask.title}</h3>
      <p className="desc">{ask.desc}</p>
      <div className="meta">Posted {ask.posted}</div>
      <div className="foot row">
        {!ask.mine ? (
          <>
            <button type="button" className="btn" disabled>
              {ask.approval ? "Request to claim" : "Claim this"}
            </button>
            {ask.approval ? <span className="note">Staff approve this one first.</span> : null}
          </>
        ) : ask.mine === "claimed" ? (
          <>
            <button type="button" className="btn" disabled>
              Submit content
            </button>
            <button type="button" className="btn ghost" disabled>
              Give it back
            </button>
          </>
        ) : ask.mine === "requested" ? (
          <span className="note">Waiting for staff to approve.</span>
        ) : (
          <span className="note">Delivered and accepted.</span>
        )}
      </div>
    </article>
  );
}

function AthleteHub() {
  const [tab, setTab] = useState<"open" | "mine" | "done">("open");
  const open = ASKS.filter((a) => !a.mine);
  const mine = ASKS.filter((a) => a.mine && a.mine !== "delivered");
  const done = ASKS.filter((a) => a.mine === "delivered");
  const list = tab === "open" ? open : tab === "mine" ? mine : done;
  return (
    <>
      <PageHead
        title="Content Hub"
        sub="Content the NIL TV team is looking for. Claim what you want to make, film it, and send it in here."
        access="You and staff"
      />
      <PreviewBanner />
      <Tabs
        idBase="hub"
        label="Asks"
        value={tab}
        onChange={setTab}
        tabs={[
          { key: "open", label: "Open asks", count: open.length },
          { key: "mine", label: "My claims", count: mine.length },
          { key: "done", label: "Delivered", count: done.length },
        ]}
      />
      <div id="hub-panel" role="tabpanel" aria-labelledby={`hub-${tab}`}>
        {list.length ? (
          <div className="grid">
            {list.map((a) => (
              <AskCard key={a.id} ask={a} />
            ))}
          </div>
        ) : (
          <Empty>Nothing here yet.</Empty>
        )}
      </div>
    </>
  );
}

function StaffHub() {
  const claims = ASKS.flatMap((a) => a.claims);
  const n = (s: ClaimState) => claims.filter((c) => c.status === s).length;
  const pending = ASKS.flatMap((a) => a.claims.filter((c) => c.status === "requested").map((c) => ({ a, c })));
  return (
    <>
      <PageHead title="Content Hub" sub="Every ask, who claimed it, and what has come in." access="Staff and admins" />
      <PreviewBanner />
      <div className="stats">
        <div className="stat">
          <b>{ASKS.length}</b>
          <span>Open asks</span>
        </div>
        <div className="stat">
          <b>{n("requested")}</b>
          <span>Waiting approval</span>
        </div>
        <div className="stat">
          <b>{n("claimed")}</b>
          <span>Claimed</span>
        </div>
        <div className="stat">
          <b>{n("submitted")}</b>
          <span>In review</span>
        </div>
        <div className="stat">
          <b>{n("delivered")}</b>
          <span>Delivered</span>
        </div>
      </div>
      <div className="bar">
        <h2>All asks</h2>
        <button type="button" className="btn" disabled>
          Post a new ask
        </button>
      </div>
      <div className="tablewrap">
        <table>
          <thead>
            <tr>
              <th scope="col">Ask</th>
              <th scope="col">Approval</th>
              <th scope="col">Claims</th>
            </tr>
          </thead>
          <tbody>
            {ASKS.map((a) => (
              <tr key={a.id}>
                <td>
                  <div className="t">{a.title}</div>
                  <div className="c">
                    {a.format} · {a.target} · Posted {a.posted}
                  </div>
                </td>
                <td>{a.approval ? <Pill tone="warn">On</Pill> : <Pill tone="neutral">Off</Pill>}</td>
                <td>
                  {a.claims.length ? (
                    <div className="who-list">
                      {a.claims.map((c) => (
                        <div className="who-row" key={c.who}>
                          {c.who} <Pill tone={CLAIM[c.status].tone}>{CLAIM[c.status].label}</Pill>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <span className="muted">No claims yet</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="bar">
        <h2>Claim requests</h2>
      </div>
      <p className="note">
        Asks with approval on land here. Approve and the athlete can start filming. Decline and the ask stays open.
      </p>
      <div className="tablewrap">
        <table>
          <thead>
            <tr>
              <th scope="col">Athlete</th>
              <th scope="col">Ask</th>
              <th scope="col">Format</th>
              <th scope="col">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {pending.map(({ a, c }) => (
              <tr key={`${a.id}-${c.who}`}>
                <td className="t">{c.who}</td>
                <td>
                  {a.title}
                  <div className="c">{a.target}</div>
                </td>
                <td>{a.format}</td>
                <td>
                  <div className="row">
                    <button type="button" className="btn sm" disabled>
                      Approve
                    </button>
                    <button type="button" className="btn ghost sm" disabled>
                      Decline
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

export function ContentHub() {
  const { member } = useMe();
  return member.role === "athlete" ? <AthleteHub /> : <StaffHub />;
}
