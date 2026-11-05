/** Staff side of the Content Hub: post asks, decide on claims, review what athletes send. */
import { ASK_FORMAT_LABELS, type Ask, type AskClaim, type ClaimStatus, type SubmissionFile } from "@niltv/types";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, errorText } from "../../api";
import { CLAIM, formatBytes } from "../../lib/hub";
import { formatShortDate } from "../../lib/time";
import { qk, useAsks } from "../../queries";
import { Empty, ErrorNote, Loading, PageHead, Pill } from "../../ui/bits";
import { useMe } from "../../ui/me";
import { useToast } from "../../ui/Toast";
import { useFlash } from "../../ui/useFlash";
import { AskForm } from "./AskForm";
import { openFile } from "./shared";

export function StaffHub({ id }: { id?: string }) {
  const { zone } = useMe();
  const asks = useAsks();
  const [editing, setEditing] = useState<Ask | "new" | null>(null);
  const list = asks.data ?? [];
  const target = id ? list.find((a) => a.id === id) : undefined;
  useFlash(target ? `ask-${target.id}` : undefined, Boolean(target));

  const pairs = list.flatMap((a) => (a.claims ?? []).map((c) => ({ a, c })));
  const n = (s: ClaimStatus) => pairs.filter((p) => p.c.status === s).length;
  const requests = pairs.filter((p) => p.c.status === "requested");
  const review = pairs.filter((p) => p.c.status === "submitted");
  const open = list.filter((a) => a.status === "open");
  const closed = list.filter((a) => a.status === "closed");

  const row = (a: Ask) => (
    <tr key={a.id} id={`ask-${a.id}`}>
      <td>
        <div className="t">{a.title}</div>
        <div className="c">
          {ASK_FORMAT_LABELS[a.format]} · {a.audienceLabel} · Posted {formatShortDate(a.createdAt, zone)}
        </div>
      </td>
      <td data-label="Approval">{a.requiresApproval ? <Pill tone="warn">On</Pill> : <Pill tone="neutral">Off</Pill>}</td>
      <td data-label="Claims">
        {a.claims?.length ? (
          <div className="who-list">
            {a.claims.map((c) => (
              <div className="who-row" key={c.person.sub}>
                {c.person.name} <Pill tone={CLAIM[c.status].tone}>{CLAIM[c.status].label}</Pill>
              </div>
            ))}
          </div>
        ) : (
          <span className="muted">No claims yet</span>
        )}
      </td>
      <td>
        <button type="button" className="btn ghost sm" onClick={() => setEditing(a)}>
          Edit
        </button>
      </td>
    </tr>
  );

  const table = (rows: Ask[]) => (
    <div className="tablewrap">
      <table>
        <thead>
          <tr>
            <th scope="col">Ask</th>
            <th scope="col">Approval</th>
            <th scope="col">Claims</th>
            <th scope="col">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>{rows.map(row)}</tbody>
      </table>
    </div>
  );

  return (
    <>
      <PageHead title="Content Hub" access="Staff and admins" />
      {id && asks.data && !target ? <p className="err">That ask is not listed.</p> : null}
      {asks.isPending ? <Loading /> : null}
      <ErrorNote error={asks.error} onRetry={() => void asks.refetch()} />
      {asks.data ? (
        <div className="stats">
          <div className="stat">
            <b>{open.length}</b>
            <span>Open asks</span>
          </div>
          <div className="stat">
            <b>{requests.length}</b>
            <span>Waiting approval</span>
          </div>
          <div className="stat">
            <b>{n("claimed") + n("changes")}</b>
            <span>Being made</span>
          </div>
          <div className="stat">
            <b>{review.length}</b>
            <span>In review</span>
          </div>
          <div className="stat">
            <b>{n("delivered")}</b>
            <span>Delivered</span>
          </div>
        </div>
      ) : null}

      {review.length ? (
        <>
          <div className="bar">
            <h2>In review</h2>
          </div>
          <div className="grid">
            {review.map(({ a, c }) => (
              <ReviewCard key={`${a.id}-${c.person.sub}`} ask={a} claim={c} />
            ))}
          </div>
        </>
      ) : null}

      {requests.length ? (
        <>
          <div className="bar">
            <h2>Claim requests</h2>
          </div>
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
                {requests.map(({ a, c }) => (
                  <RequestRow key={`${a.id}-${c.person.sub}`} ask={a} claim={c} />
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      <div className="bar">
        <h2>All asks</h2>
        {editing ? null : (
          <button type="button" className="btn" onClick={() => setEditing("new")}>
            Post a new ask
          </button>
        )}
      </div>
      {editing ? (
        <AskForm
          key={editing === "new" ? "new" : editing.id}
          ask={editing === "new" ? undefined : editing}
          onDone={() => setEditing(null)}
        />
      ) : null}
      {asks.data && list.length === 0 ? <Empty>No asks yet.</Empty> : null}
      {open.length ? table(open) : null}
      {closed.length ? (
        <details>
          <summary className="lbl">Closed ({closed.length})</summary>
          <div style={{ marginTop: 12 }}>{table(closed)}</div>
        </details>
      ) : null}
    </>
  );
}

function RequestRow({ ask, claim }: { ask: Ask; claim: AskClaim }) {
  const qc = useQueryClient();
  const toast = useToast();
  const decide = useMutation({
    mutationFn: (approved: boolean) => api.askAction(ask.id, { action: "decide", personSub: claim.person.sub, approved }),
    onSuccess: (_, approved) => {
      void qc.invalidateQueries({ queryKey: qk.asks });
      toast(approved ? "Approved." : "Declined.");
    },
  });
  return (
    <tr>
      <td className="t">{claim.person.name}</td>
      <td data-label="Ask">
        <div>
          {ask.title}
          <div className="c">{ask.audienceLabel}</div>
        </div>
      </td>
      <td data-label="Format">{ASK_FORMAT_LABELS[ask.format]}</td>
      <td>
        <div className="row">
          <button type="button" className="btn sm" disabled={decide.isPending} onClick={() => decide.mutate(true)}>
            Approve
          </button>
          <button type="button" className="btn ghost sm" disabled={decide.isPending} onClick={() => decide.mutate(false)}>
            Decline
          </button>
        </div>
        {decide.error ? (
          <p className="err" role="alert">
            {errorText(decide.error)}
          </p>
        ) : null}
      </td>
    </tr>
  );
}

function ReviewCard({ ask, claim }: { ask: Ask; claim: AskClaim }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState("");
  const review = useMutation({
    mutationFn: (outcome: "delivered" | "changes") =>
      api.askAction(ask.id, { action: "review", personSub: claim.person.sub, outcome, note: note.trim() }),
    onSuccess: (_, outcome) => {
      void qc.invalidateQueries({ queryKey: qk.asks });
      toast(outcome === "delivered" ? "Accepted." : "Sent back with your note.");
    },
  });
  const open = useMutation({ mutationFn: (f: SubmissionFile) => openFile(ask.id, claim.person.sub, f.id) });
  const error = review.error ?? open.error;

  return (
    <article className="card" aria-label={`${claim.person.name}: ${ask.title}`}>
      <div className="card-top">
        <span className="row tight">
          <span className={`fmt${ask.format === "long" ? " long" : ""}`}>{ASK_FORMAT_LABELS[ask.format]}</span>
          <span className="tgt">{claim.person.name}</span>
        </span>
        <Pill tone={CLAIM[claim.status].tone}>{CLAIM[claim.status].label}</Pill>
      </div>
      <h3>{ask.title}</h3>
      {claim.note ? <p className="desc">{claim.note}</p> : null}
      <ul className="hub-files">
        {claim.files.map((f) => (
          <li key={f.id}>
            <button type="button" className="linkbtn" onClick={() => open.mutate(f)}>
              {f.name}
            </button>
            <span className="meta">{formatBytes(f.size)}</span>
          </li>
        ))}
      </ul>
      {asking ? (
        <div className="field">
          <label htmlFor={`rv-${ask.id}-${claim.person.sub}`}>What needs to change?</label>
          <textarea
            id={`rv-${ask.id}-${claim.person.sub}`}
            rows={3}
            maxLength={1000}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>
      ) : null}
      {error ? (
        <p className="err" role="alert">
          {errorText(error)}
        </p>
      ) : null}
      <div className="foot row">
        {asking ? (
          <>
            <button
              type="button"
              className="btn"
              disabled={review.isPending || !note.trim()}
              onClick={() => review.mutate("changes")}
            >
              Send back
            </button>
            <button type="button" className="btn ghost" onClick={() => setAsking(false)}>
              Cancel
            </button>
          </>
        ) : (
          <>
            <button type="button" className="btn" disabled={review.isPending} onClick={() => review.mutate("delivered")}>
              Accept
            </button>
            <button type="button" className="btn ghost" onClick={() => setAsking(true)}>
              Needs changes
            </button>
          </>
        )}
      </div>
    </article>
  );
}
