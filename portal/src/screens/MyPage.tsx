/** My athlete page: ask the team to change the public page, and follow the requests. */
import { PortalRequestCreate, type PortalRequestsResponse } from "@niltv/types";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { api, errorText } from "../api";
import { describeIssues, isHttpUrl, REQUEST_STATUS } from "../lib/format";
import { formatShortDate } from "../lib/time";
import { qk, useRequests } from "../queries";
import { Empty, ErrorNote, Loading, PageHead, Pill } from "../ui/bits";
import { useMe } from "../ui/me";
import { useToast } from "../ui/Toast";

export function MyPage() {
  const { zone } = useMe();
  const qc = useQueryClient();
  const toast = useToast();
  const requests = useRequests();
  const [body, setBody] = useState("");
  const [link, setLink] = useState("");
  const [error, setError] = useState<string | null>(null);

  const send = useMutation({
    mutationFn: (input: ReturnType<typeof PortalRequestCreate.parse>) => api.createRequest(input),
    onSuccess: (created) => {
      qc.setQueryData<PortalRequestsResponse>(qk.requests, (old) => (old ? { requests: [created, ...old.requests] } : old));
      void qc.invalidateQueries({ queryKey: qk.requests });
      setBody("");
      setLink("");
      toast("Sent. The team sees it in their request queue.");
    },
    onError: (err) => setError(errorText(err)),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const l = link.trim();
    if (body.trim().length < 5) return setError("Tell us what should change (a few words at least).");
    if (l && !isHttpUrl(l)) return setError("The link must be a full link starting with https://.");
    const parsed = PortalRequestCreate.safeParse({ body: body.trim(), ...(l ? { link: l } : {}) });
    if (!parsed.success) return setError(describeIssues(parsed.error.issues));
    send.mutate(parsed.data);
  };

  const list = requests.data ?? [];

  return (
    <>
      <PageHead
        title="My athlete page"
        sub="Your public page on niltv.com. Changes go through the team so the page stays accurate."
        access="Requests: you and staff"
      />
      <div className="panel">
        <form onSubmit={submit} aria-labelledby="req-h" noValidate>
          <h3 id="req-h">Request a change</h3>
          <div className="field">
            <label htmlFor="rq-body">What should change?</label>
            <textarea
              id="rq-body"
              rows={5}
              maxLength={4000}
              required
              value={body}
              placeholder="What the page says now and what it should say"
              onChange={(e) => setBody(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="rq-link">Link (optional)</label>
            <input
              id="rq-link"
              type="url"
              inputMode="url"
              maxLength={500}
              value={link}
              placeholder="A photo, stats page or new social handle"
              aria-describedby="rq-link-help"
              onChange={(e) => setLink(e.target.value)}
            />
            <span id="rq-link-help" className="hint">
              For a new photo, share a Drive or Dropbox link.
            </span>
          </div>
          {error ? (
            <p className="err" role="alert">
              {error}
            </p>
          ) : null}
          <div className="row">
            <button className="btn" type="submit" disabled={send.isPending}>
              {send.isPending ? "Sending…" : "Send request"}
            </button>
            <span className="note">The team usually updates pages within two business days.</span>
          </div>
        </form>
      </div>

      <div className="bar">
        <h2>Your requests</h2>
      </div>
      {requests.isPending ? <Loading /> : null}
      <ErrorNote error={requests.error} onRetry={() => void requests.refetch()} />
      {requests.data && list.length === 0 ? <Empty>No requests yet.</Empty> : null}
      {list.length ? (
        <div className="tablewrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Sent</th>
                <th scope="col">Request</th>
                <th scope="col">Status</th>
                <th scope="col">Note from the team</th>
              </tr>
            </thead>
            <tbody>
              {list.map((r) => {
                const s = REQUEST_STATUS[r.status];
                return (
                  <tr key={r.id}>
                    <td className="num">{formatShortDate(r.createdAt, zone)}</td>
                    <td>
                      <div style={{ whiteSpace: "pre-line" }}>{r.body}</div>
                      {r.link ? (
                        <a className="c" href={r.link} target="_blank" rel="noopener noreferrer">
                          {r.link}
                        </a>
                      ) : null}
                    </td>
                    <td>
                      <Pill tone={s.tone}>{s.label}</Pill>
                    </td>
                    <td>{r.staffNote ?? <span className="muted">None</span>}</td>
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
