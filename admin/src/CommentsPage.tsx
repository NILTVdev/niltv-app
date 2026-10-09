/**
 * Comment moderation: the open queue (filter-held and report-hidden
 * comments) plus a per-clip lookup. Minors' comments are flagged so they can
 * be reviewed first. Removal is a tombstone server-side and needs a reason.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "./api";

type View = "pending" | "reported" | "clip";

export function CommentsPage() {
  const qc = useQueryClient();
  const [view, setView] = useState<View>("pending");
  const [contentId, setContentId] = useState("");
  const [lookup, setLookup] = useState("");
  const [error, setError] = useState<string | null>(null);

  const listQ = useQuery({
    queryKey: ["comments", view, lookup],
    queryFn: () => api.listComments(view === "clip" ? { contentId: lookup } : { queue: view }),
    enabled: view !== "clip" || lookup.length > 0,
  });

  const act = useMutation({
    mutationFn: (fn: () => Promise<unknown>) => fn(),
    onSuccess: () => {
      setError(null);
      return qc.invalidateQueries({ queryKey: ["comments"] });
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Action failed."),
  });

  function remove(id: string) {
    const reason = window.prompt("Reason for removing this comment (kept for audit):");
    if (!reason?.trim()) return;
    act.mutate(() => api.removeComment(id, reason.trim()));
  }

  const items = listQ.data?.comments ?? [];
  // Minors first within the queue.
  const sorted = [...items].sort((a, b) => Number(a.authorIs18plus) - Number(b.authorIs18plus));

  return (
    <section>
      <h2>Comments</h2>
      <div className="toolbar">
        {(["pending", "reported", "clip"] as const).map((v) => (
          <button key={v} className={`btn${view === v ? " active" : ""}`} onClick={() => setView(v)}>
            {v === "pending" ? "Held for review" : v === "reported" ? "Hidden by reports" : "Find by clip"}
          </button>
        ))}
        {view === "clip" ? (
          <>
            <input placeholder="Content id (c-…)" value={contentId} onChange={(e) => setContentId(e.target.value)} />
            <button className="btn" onClick={() => setLookup(contentId.trim())}>
              Load
            </button>
          </>
        ) : null}
      </div>
      {error ? <div className="error-banner">{error}</div> : null}
      {listQ.isPending && listQ.fetchStatus !== "idle" ? <p className="hint">Loading…</p> : null}
      {listQ.isError ? <div className="error-banner">Couldn&apos;t load comments.</div> : null}
      {listQ.isSuccess && sorted.length === 0 ? <p className="hint">Nothing to review.</p> : null}
      {sorted.length > 0 ? (
        <table>
          <thead>
            <tr>
              <th>Comment</th>
              <th>Author</th>
              <th>Status</th>
              <th>Reports</th>
              <th>Posted</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {sorted.map((c) => (
              <tr key={c.id}>
                {/* React escapes the text; comment bodies are untrusted. */}
                <td>{c.body}</td>
                <td>
                  {c.authorName}
                  {c.authorIs18plus ? "" : " (minor)"}
                </td>
                <td>{c.status}</td>
                <td>{c.reportCount}</td>
                <td>{new Date(c.createdAt).toLocaleString()}</td>
                <td>
                  {c.status === "pending" ? (
                    <button className="btn" disabled={act.isPending} onClick={() => act.mutate(() => api.commentAction(c.id, "approve"))}>
                      Approve
                    </button>
                  ) : null}
                  {c.status === "hidden" ? (
                    <button className="btn" disabled={act.isPending} onClick={() => act.mutate(() => api.commentAction(c.id, "restore"))}>
                      Restore
                    </button>
                  ) : null}{" "}
                  <button className="btn danger" disabled={act.isPending} onClick={() => remove(c.id)}>
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </section>
  );
}
