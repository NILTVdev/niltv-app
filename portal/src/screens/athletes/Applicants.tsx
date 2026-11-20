/**
 * Applicants on Athletes: every niltv.com athlete application still in play,
 * with a checklist of what each one is missing. Onboarding itself (review,
 * agreement, Stripe) stays in the dashboard; once every step is done an admin
 * approves the athlete here and they get portal access.
 */
import type { PortalApplicant } from "@niltv/types";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { api, errorText } from "../../api";
import { type Standing, STANDING_LABEL, applicantSteps, nextStep, standing } from "../../lib/applicants";
import { campusName, plural, type Tone } from "../../lib/format";
import { formatShortDate } from "../../lib/time";
import { patchMember, qk, useApplicants } from "../../queries";
import { Empty, ErrorNote, Loading, Pill } from "../../ui/bits";
import { useMe } from "../../ui/me";
import { useToast } from "../../ui/Toast";

type Filter = Standing | "" | "waiting";

const TONE: Record<Standing, Tone> = {
  ready: "warn",
  syncing: "info",
  account: "bad",
  onboarding: "neutral",
  active: "ok",
  disabled: "neutral",
};

export function Applicants({ admin }: { admin: boolean }) {
  const applicants = useApplicants();
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("waiting");

  const rows = useMemo(() => (applicants.data ?? []).map((a) => ({ a, s: standing(a) })), [applicants.data]);
  const ready = rows.filter((r) => r.s === "ready").length;
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return rows
      .filter(({ s }) => !filter || (filter === "waiting" ? s !== "active" && s !== "disabled" : s === filter))
      .filter(({ a }) => !needle || `${a.name} ${a.email} ${a.school ?? ""}`.toLowerCase().includes(needle))
      .sort((x, y) => order(x.s) - order(y.s) || x.a.name.localeCompare(y.a.name));
  }, [rows, q, filter]);

  return (
    <>
      {ready > 0 ? (
        <div className="callout" role="status">
          <span>
            <b>{plural(ready, "athlete")}</b> finished every step and {ready === 1 ? "is" : "are"} waiting for approval.
            {admin ? "" : " An admin approves them."}
          </span>
          <button type="button" className="btn sm" onClick={() => setFilter("ready")}>
            Show them
          </button>
        </div>
      ) : null}
      <div className="two" role="search" aria-label="Filter applicants">
        <div className="field">
          <label htmlFor="ap-q">Search</label>
          <input id="ap-q" type="search" value={q} placeholder="Name, email or school" onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="ap-filter">Show</label>
          <select id="ap-filter" value={filter} onChange={(e) => setFilter(e.target.value as Filter)}>
            <option value="waiting">Not in the portal yet</option>
            <option value="ready">{STANDING_LABEL.ready}</option>
            <option value="account">{STANDING_LABEL.account}</option>
            <option value="onboarding">{STANDING_LABEL.onboarding}</option>
            <option value="active">{STANDING_LABEL.active}</option>
            <option value="">Everyone</option>
          </select>
        </div>
      </div>
      {applicants.isPending ? <Loading what="Loading applications" /> : null}
      <ErrorNote error={applicants.error} onRetry={() => void applicants.refetch()} />
      {applicants.data ? (
        <p className="meta" role="status">
          Showing {shown.length} of {plural(rows.length, "application")}. Review, the agreement and Stripe happen in the
          dashboard; this list follows it.
        </p>
      ) : null}
      {applicants.data && shown.length === 0 ? <Empty>No applicants match.</Empty> : null}
      {shown.length ? (
        <div className="tablewrap">
          <table className="roster applicants">
            <thead>
              <tr>
                <th scope="col">Athlete</th>
                <th scope="col">Campus</th>
                <th scope="col">Steps</th>
                <th scope="col">Where they are</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.map(({ a, s }) => (
                <ApplicantRow key={a.applicationId} a={a} s={s} admin={admin} />
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <p className="hint">
        Athletes sign in with their niltv.com account. Someone with no account creates one at niltv.com with the email on
        their application, and shows up here within 30 minutes.
      </p>
    </>
  );
}

const ORDER: Standing[] = ["ready", "syncing", "account", "onboarding", "active", "disabled"];
const order = (s: Standing): number => ORDER.indexOf(s);

function ApplicantRow({ a, s, admin }: { a: PortalApplicant; s: Standing; admin: boolean }) {
  const { zone } = useMe();
  const qc = useQueryClient();
  const toast = useToast();
  const approve = useMutation({
    mutationFn: () => api.updateMember(a.memberSub!, { status: "active" }),
    onSuccess: (next) => {
      patchMember(qc, next);
      void qc.invalidateQueries({ queryKey: qk.members });
      void qc.invalidateQueries({ queryKey: qk.applicants });
      toast(`${next.name} has portal access.`);
    },
  });
  const steps = applicantSteps(a);
  const where = s === "onboarding" ? nextStep(a) : s === "syncing" ? "Joins this list as ready within 30 minutes" : "";

  return (
    <tr>
      <td>
        <div className="t">{a.name}</div>
        <div className="c">
          {a.email}
          {a.appliedAt ? ` · applied ${formatShortDate(a.appliedAt, zone)}` : ""}
        </div>
      </td>
      <td data-label="Campus">
        <div>
          {campusName(a.campus) || a.school || <span className="muted">None</span>}
          {a.sport ? <div className="c">{a.sport}</div> : null}
        </div>
      </td>
      <td data-label="Steps">
        <ul className="steps" aria-label={`Steps for ${a.name}`}>
          {steps.map((step) => (
            <li key={step.key} className={step.state}>
              <span aria-hidden="true">{step.state === "done" ? "✓" : step.state === "skipped" ? "–" : "○"}</span>
              {step.label}
              <span className="sr-only">: {step.state === "done" ? "done" : step.state === "skipped" ? "not needed" : "not yet"}</span>
            </li>
          ))}
        </ul>
      </td>
      <td data-label="Where they are">
        <div>
          <Pill tone={TONE[s]}>{STANDING_LABEL[s]}</Pill>
          {where ? <div className="c">{where}</div> : null}
        </div>
      </td>
      <td>
        {s === "ready" && admin ? (
          <button
            type="button"
            className="btn sm"
            disabled={approve.isPending}
            aria-label={`Approve ${a.name} for the portal`}
            onClick={() => approve.mutate()}
          >
            {approve.isPending ? "Approving…" : "Approve"}
          </button>
        ) : null}
        {approve.error ? (
          <p className="err" role="alert" style={{ marginTop: 6 }}>
            {errorText(approve.error)}
          </p>
        ) : null}
      </td>
    </tr>
  );
}
