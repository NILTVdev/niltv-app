/** Requests (staff): athlete page change requests. Mark done or declined, with a note. */
import { type PortalRequest, type PortalRequestStatus, type PortalRequestsResponse } from "@niltv/types";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, errorText } from "../api";
import { REQUEST_STATUS } from "../lib/format";
import { formatShortDate } from "../lib/time";
import { qk, useRequests } from "../queries";
import { Empty, ErrorNote, Loading, PageHead, Pill } from "../ui/bits";
import { useMe } from "../ui/me";
import { useToast } from "../ui/Toast";

const FILTERS: PortalRequestStatus[] = ["open", "done", "declined"];

export function Requests() {
  const requests = useRequests();
  const [filter, setFilter] = useState<PortalRequestStatus>("open");
  const all = requests.data ?? [];
  const list = all.filter((r) => r.status === filter);

  return (
    <>
      <PageHead
        title="Requests"
        access="Staff and admins"
      />
      <div className="chips" role="group" aria-label="Show requests">
        {FILTERS.map((f) => (
          <button key={f} type="button" className="chip" aria-pressed={filter === f} onClick={() => setFilter(f)}>
            {REQUEST_STATUS[f].label} ({all.filter((r) => r.status === f).length})
          </button>
        ))}
      </div>
      {requests.isPending ? <Loading /> : null}
      <ErrorNote error={requests.error} onRetry={() => void requests.refetch()} />
      {requests.data && list.length === 0 ? (
        <Empty>{filter === "open" ? "No open requests." : `No ${REQUEST_STATUS[filter].label.toLowerCase()} requests.`}</Empty>
      ) : null}
      <div className="stack">
        {list.map((r) => (
          <RequestCard key={r.id} r={r} />
        ))}
      </div>
    </>
  );
}

function RequestCard({ r }: { r: PortalRequest }) {
  const { zone } = useMe();
  const qc = useQueryClient();
  const toast = useToast();
  const [note, setNote] = useState(r.staffNote ?? "");
  const s = REQUEST_STATUS[r.status];

  const update = useMutation({
    mutationFn: (status: PortalRequestStatus) =>
      api.updateRequest(r.id, { status, ...(note.trim() ? { staffNote: note.trim() } : {}) }),
    onSuccess: (next) => {
      qc.setQueryData<PortalRequestsResponse>(qk.requests, (old) =>
        old ? { requests: old.requests.map((x) => (x.id === next.id ? next : x)) } : old,
      );
      toast(
        next.status === "done"
          ? "Marked done. The athlete sees it on their page tab."
          : next.status === "declined"
            ? "Declined. The athlete sees your note."
            : "Reopened.",
      );
    },
  });

  return (
    <article className="card" aria-labelledby={`rq-h-${r.id}`}>
      <div className="card-top">
        <span className="row tight">
          <span className="fmt" id={`rq-h-${r.id}`}>
            {r.person.name}
          </span>
          <span className="tgt">Sent {formatShortDate(r.createdAt, zone)}</span>
        </span>
        <Pill tone={s.tone}>{s.label}</Pill>
      </div>
      <p className="desc" style={{ color: "var(--text)" }}>
        {r.body}
      </p>
      {r.link ? (
        <a href={r.link} target="_blank" rel="noopener noreferrer" className="note" style={{ overflowWrap: "anywhere" }}>
          {r.link}
        </a>
      ) : null}
      {r.status !== "open" ? (
        <p className="meta">
          {s.label} {r.resolvedAt ? formatShortDate(r.resolvedAt, zone) : ""}
          {r.resolvedByName ? ` by ${r.resolvedByName}` : ""}
          {r.staffNote ? `. Note: ${r.staffNote}` : ""}
        </p>
      ) : null}
      {r.status === "open" ? (
        <div className="field">
          <label htmlFor={`rq-note-${r.id}`}>Note for the athlete (optional)</label>
          <input id={`rq-note-${r.id}`} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
      ) : null}
      {update.error ? (
        <p className="err" role="alert">
          {errorText(update.error)}
        </p>
      ) : null}
      <div className="foot row">
        {r.status === "open" ? (
          <>
            <button type="button" className="btn sm" disabled={update.isPending} onClick={() => update.mutate("done")}>
              Mark done
            </button>
            <button type="button" className="btn ghost sm" disabled={update.isPending} onClick={() => update.mutate("declined")}>
              Decline
            </button>
          </>
        ) : (
          <button type="button" className="btn ghost sm" disabled={update.isPending} onClick={() => update.mutate("open")}>
            Reopen
          </button>
        )}
      </div>
    </article>
  );
}
