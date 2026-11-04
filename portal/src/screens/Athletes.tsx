/**
 * Athletes (staff): the roster with search and filters. Staff fix campus
 * and sport; admins enable accepted athletes (ready → active) and disable.
 */
import { type PortalMember, type PortalMemberStatus, PORTAL_SPORTS } from "@niltv/types";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { api, errorText } from "../api";
import { CAMPUS_OPTIONS, campusName, MEMBER_STATUS, plural, STRIPE_STATUS } from "../lib/format";
import { formatSeen } from "../lib/time";
import { patchMember, qk, useMembers, useOpenDesk } from "../queries";
import { Empty, ErrorNote, Loading, PageHead, Pill } from "../ui/bits";
import { useMe } from "../ui/me";
import { useToast } from "../ui/Toast";

export function Athletes() {
  const { can } = useMe();
  const admin = can("manageAccess");
  const members = useMembers();
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<PortalMemberStatus | "">("");
  const [campus, setCampus] = useState("");
  const [sport, setSport] = useState("");

  const athletes = useMemo(() => (members.data ?? []).filter((m) => m.role === "athlete"), [members.data]);
  const ready = athletes.filter((m) => m.status === "ready").length;
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return athletes
      .filter((m) => !needle || `${m.name} ${m.email} ${m.instagram ?? ""}`.toLowerCase().includes(needle))
      .filter((m) => !status || m.status === status)
      .filter((m) => !campus || (campus === "none" ? !m.campus : m.campus === campus))
      .filter((m) => !sport || (sport === "none" ? !m.sport : m.sport === sport))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [athletes, q, status, campus, sport]);

  return (
    <>
      <PageHead
        title="Athletes"
        sub="Everyone on the roster. Campus and sport decide which channels they join."
        access="Staff and admins"
      />
      {ready > 0 ? (
        <div className="callout" role="status">
          <span>
            <b>{plural(ready, "accepted athlete")}</b> {ready === 1 ? "is" : "are"} waiting for portal access.{" "}
            {admin ? "Enable them below." : "An admin enables them."}
          </span>
          <button type="button" className="btn sm" onClick={() => setStatus("ready")}>
            Show waiting
          </button>
        </div>
      ) : null}
      <div className="two" role="search" aria-label="Filter athletes">
        <div className="field">
          <label htmlFor="at-q">Search</label>
          <input id="at-q" type="search" value={q} placeholder="Name, email or Instagram" onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="at-status">Status</label>
          <select id="at-status" value={status} onChange={(e) => setStatus(e.target.value as PortalMemberStatus | "")}>
            <option value="">Any status</option>
            <option value="active">Active</option>
            <option value="ready">Waiting</option>
            <option value="disabled">No access</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="at-campus">Campus</label>
          <select id="at-campus" value={campus} onChange={(e) => setCampus(e.target.value)}>
            <option value="">Any campus</option>
            <option value="none">No campus set</option>
            {CAMPUS_OPTIONS.map((c) => (
              <option key={c.slug} value={c.slug}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="at-sport">Sport</label>
          <select id="at-sport" value={sport} onChange={(e) => setSport(e.target.value)}>
            <option value="">Any sport</option>
            <option value="none">No sport set</option>
            {PORTAL_SPORTS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
      </div>
      {members.isPending ? <Loading /> : null}
      <ErrorNote error={members.error} onRetry={() => void members.refetch()} />
      {members.data ? (
        <p className="meta" role="status">
          Showing {shown.length} of {plural(athletes.length, "athlete")}.
        </p>
      ) : null}
      {members.data && shown.length === 0 ? <Empty>No athletes match.</Empty> : null}
      {shown.length ? (
        <div className="tablewrap">
          <table className="roster">
            <thead>
              <tr>
                <th scope="col">Athlete</th>
                <th scope="col">Campus</th>
                <th scope="col">Sport</th>
                <th scope="col">Status</th>
                <th scope="col">Stripe</th>
                <th scope="col">Last seen</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.map((m) => (
                <AthleteRow key={m.sub} m={m} admin={admin} />
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </>
  );
}

function AthleteRow({ m, admin }: { m: PortalMember; admin: boolean }) {
  const { zone } = useMe();
  const qc = useQueryClient();
  const toast = useToast();
  const openDesk = useOpenDesk();
  const [editing, setEditing] = useState(false);
  const [campus, setCampus] = useState(m.campus ?? "");
  const [sport, setSport] = useState(m.sport ?? "");

  const update = useMutation({
    mutationFn: (input: Parameters<typeof api.updateMember>[1]) => api.updateMember(m.sub, input),
    onSuccess: (next, input) => {
      patchMember(qc, next);
      void qc.invalidateQueries({ queryKey: qk.members });
      setEditing(false);
      toast(
        input.status === "active"
          ? `${next.name} has portal access.`
          : input.status === "disabled"
            ? `${next.name} no longer has portal access.`
            : "Saved. Channels follow the new campus and sport.",
      );
    },
  });

  const status = MEMBER_STATUS[m.status];
  const stripe = m.stripe ? STRIPE_STATUS[m.stripe] : undefined;

  return (
    <>
      <tr>
        <td>
          <div className="t">{m.name}</div>
          <div className="c">
            {m.email}
            {m.instagram ? ` · @${m.instagram.replace(/^@/, "")}` : ""}
          </div>
        </td>
        <td data-label="Campus">{campusName(m.campus) || <span className="muted">None</span>}</td>
        <td data-label="Sport">{m.sport ?? <span className="muted">None</span>}</td>
        <td data-label="Status">
          <Pill tone={status.tone}>{status.label}</Pill>
        </td>
        <td data-label="Stripe">
          {stripe ? <Pill tone={stripe.tone}>{stripe.label}</Pill> : <span className="muted">Unknown</span>}
        </td>
        <td className="num" data-label="Last seen">
          {formatSeen(m.lastSeenAt, zone)}
        </td>
        <td>
          <div className="row">
            {editing ? null : (
              <button type="button" className="btn ghost sm" onClick={() => setEditing(true)} aria-label={`Edit campus and sport for ${m.name}`}>
                Edit
              </button>
            )}
            {admin && m.status !== "active" ? (
              <button
                type="button"
                className="btn sm"
                disabled={update.isPending}
                onClick={() => update.mutate({ status: "active" })}
                aria-label={`Enable ${m.name}`}
              >
                Enable
              </button>
            ) : null}
            {m.status === "active" ? (
              <button
                type="button"
                className="btn ghost sm"
                disabled={openDesk.isPending}
                aria-label={`Message ${m.name} from Athlete support`}
                onClick={() => openDesk.mutate({ desk: "support", personSub: m.sub })}
              >
                Message
              </button>
            ) : null}
          </div>
          {update.error || openDesk.error ? (
            <p className="err" role="alert" style={{ marginTop: 6 }}>
              {errorText(update.error ?? openDesk.error)}
            </p>
          ) : null}
        </td>
      </tr>
      {editing ? (
        <tr className="editrow">
          <td colSpan={7}>
            <div className="two">
              <div className="field">
                <label htmlFor={`ec-${m.sub}`}>
                  Campus<span className="sr-only"> for {m.name}</span>
                </label>
                <select id={`ec-${m.sub}`} value={campus} onChange={(e) => setCampus(e.target.value)}>
                  <option value="">None</option>
                  {CAMPUS_OPTIONS.map((c) => (
                    <option key={c.slug} value={c.slug}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor={`es-${m.sub}`}>
                  Sport<span className="sr-only"> for {m.name}</span>
                </label>
                <select id={`es-${m.sub}`} value={sport} onChange={(e) => setSport(e.target.value)}>
                  <option value="">None</option>
                  {PORTAL_SPORTS.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="row">
              <button
                type="button"
                className="btn sm"
                disabled={update.isPending}
                onClick={() => {
                  // Send only what changed: the server marks every sent field as
                  // staff-edited, and the onboarding sync then leaves it alone.
                  const patch = {
                    ...(campus !== (m.campus ?? "") ? { campus: campus || null } : {}),
                    ...(sport !== (m.sport ?? "") ? { sport: sport || null } : {}),
                  };
                  if (Object.keys(patch).length === 0) setEditing(false);
                  else update.mutate(patch);
                }}
              >
                Save
              </button>
              <button
                type="button"
                className="btn ghost sm"
                onClick={() => {
                  setEditing(false);
                  setCampus(m.campus ?? "");
                  setSport(m.sport ?? "");
                }}
              >
                Cancel
              </button>
              {admin && m.status === "active" ? (
                <button
                  type="button"
                  className="btn danger sm"
                  disabled={update.isPending}
                  aria-label={`Disable ${m.name}`}
                  onClick={() => {
                    if (window.confirm(`Turn off portal access for ${m.name}? They leave every channel and group.`)) {
                      update.mutate({ status: "disabled" });
                    }
                  }}
                >
                  Disable
                </button>
              ) : null}
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}
