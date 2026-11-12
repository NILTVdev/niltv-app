/** Payouts (admins): each athlete's Stripe state. Paying happens in Stripe Connect. */
import type { StripeState } from "@niltv/types";
import { useMemo, useState } from "react";
import { campusName, MEMBER_STATUS, STRIPE_STATUS } from "../lib/format";
import { useMembers } from "../queries";
import { Empty, ErrorNote, Loading, PageHead, Pill } from "../ui/bits";

const ORDER: StripeState[] = ["none", "pending", "international", "complete"];

export function Payouts() {
  const members = useMembers();
  const [picked, setFilter] = useState<StripeState | "all" | "unknown">("all");

  const athletes = useMemo(
    () =>
      (members.data ?? [])
        .filter((m) => m.role === "athlete" && m.status !== "disabled")
        .sort((a, b) => a.name.localeCompare(b.name)),
    [members.data],
  );
  const count = (s: StripeState) => athletes.filter((m) => m.stripe === s).length;
  const unknown = athletes.filter((m) => !m.stripe).length;
  const states = ORDER.filter((s) => count(s) > 0);
  // A chip hides once its count drops to 0; its filter falls back to All.
  const filter = picked === "all" || (picked === "unknown" ? unknown > 0 : states.includes(picked)) ? picked : "all";
  const shown = athletes.filter((m) => (filter === "all" ? true : filter === "unknown" ? !m.stripe : m.stripe === filter));

  return (
    <>
      <PageHead
        title="Payouts"
        access="Admins only"
      />
      <div className="bar">
        <div className="stats" style={{ border: 0, padding: 0 }}>
          {states.map((s) => (
            <div className="stat" key={s}>
              <b>{count(s)}</b>
              <span>{STRIPE_STATUS[s].label}</span>
            </div>
          ))}
        </div>
        <a className="btn ghost" href="https://dashboard.stripe.com/connect/accounts/overview" target="_blank" rel="noopener noreferrer">
          Open Stripe Connect
        </a>
      </div>
      <div className="chips" role="group" aria-label="Show athletes">
        <button type="button" className="chip" aria-pressed={filter === "all"} onClick={() => setFilter("all")}>
          All ({athletes.length})
        </button>
        {states.map((s) => (
          <button key={s} type="button" className="chip" aria-pressed={filter === s} onClick={() => setFilter(s)}>
            {STRIPE_STATUS[s].label} ({count(s)})
          </button>
        ))}
        {unknown ? (
          <button type="button" className="chip" aria-pressed={filter === "unknown"} onClick={() => setFilter("unknown")}>
            Unknown ({unknown})
          </button>
        ) : null}
      </div>
      {members.isPending ? <Loading /> : null}
      <ErrorNote error={members.error} onRetry={() => void members.refetch()} />
      {members.data && shown.length === 0 ? <Empty>No athletes here.</Empty> : null}
      {shown.length ? (
        <div className="tablewrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Athlete</th>
                <th scope="col">Campus</th>
                <th scope="col">Portal</th>
                <th scope="col">Stripe</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((m) => {
                const stripe = m.stripe ? STRIPE_STATUS[m.stripe] : undefined;
                const status = MEMBER_STATUS[m.status];
                return (
                  <tr key={m.sub}>
                    <td>
                      <div className="t">{m.name}</div>
                      <div className="c">{m.email}</div>
                    </td>
                    <td data-label="Campus">{campusName(m.campus) || <span className="muted">None</span>}</td>
                    <td data-label="Portal">
                      <Pill tone={status.tone}>{status.label}</Pill>
                    </td>
                    <td data-label="Stripe">
                      {stripe ? <Pill tone={stripe.tone}>{stripe.label}</Pill> : <span className="muted">Unknown</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
    </>
  );
}
