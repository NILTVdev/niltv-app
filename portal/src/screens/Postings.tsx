/**
 * Internal Postings: athletes mark interest; staff post, edit, close, and
 * approve or decline interest on postings that need approval.
 */
import { type Posting, PostingUpsertRequest, type PostingsResponse } from "@niltv/types";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { api, errorText } from "../api";
import { describeIssues, INTEREST_STATUS, plural } from "../lib/format";
import { formatShortDate } from "../lib/time";
import type { ScreenProps } from "../Portal";
import { qk, usePostings, useOpenDesk } from "../queries";
import { Empty, ErrorNote, Loading, PageHead, Pill, Switch } from "../ui/bits";
import { useMe } from "../ui/me";
import { useToast } from "../ui/Toast";
import { useFlash } from "../ui/useFlash";

const APPROVAL_HELP = "Staff get an email for each interested athlete and approve or decline them";

export function Postings({ id }: ScreenProps) {
  const { can } = useMe();
  return can("managePostings") ? <StaffPostings id={id} /> : <AthletePostings id={id} />;
}

function AthletePostings({ id }: { id?: string }) {
  const postings = usePostings();
  const list = postings.data ?? [];
  const target = id ? list.find((p) => p.id === id) : undefined;
  useFlash(target ? `posting-${target.id}` : undefined, Boolean(target));
  return (
    <>
      <PageHead
        title="Internal Postings"
        sub="Roles and opportunities inside NIL TV. Tap I'm interested and the team reaches out."
        access="Athletes and staff"
      />
      {id && postings.data && !target ? <p className="err">That posting is closed or no longer listed.</p> : null}
      {postings.isPending ? <Loading /> : null}
      <ErrorNote error={postings.error} onRetry={() => void postings.refetch()} />
      {postings.data ? (
        list.length ? (
          <div className="grid">
            {list.map((p) => (
              <AthleteCard key={p.id} p={p} />
            ))}
          </div>
        ) : (
          <Empty>No postings right now.</Empty>
        )
      ) : null}
    </>
  );
}

function AthleteCard({ p }: { p: Posting }) {
  const { zone } = useMe();
  const qc = useQueryClient();
  const toast = useToast();
  const interest = useMutation({
    mutationFn: (interested: boolean) => api.postingAction(p.id, { action: "interest", interested }),
    onSuccess: (_, interested) => {
      qc.setQueryData<PostingsResponse>(qk.postings, (old) =>
        old
          ? {
              postings: old.postings.map((x) => {
                if (x.id !== p.id) return x;
                const { myInterest: _drop, ...rest } = x;
                return interested ? { ...rest, myInterest: "interested" as const } : rest;
              }),
            }
          : old,
      );
      void qc.invalidateQueries({ queryKey: qk.postings });
      toast(interested ? "Got it. The team will reach out." : "Interest withdrawn.");
    },
  });
  const status = p.myInterest ? INTEREST_STATUS[p.myInterest] : undefined;
  const closed = p.status === "closed";

  return (
    <article className="card" id={`posting-${p.id}`} aria-labelledby={`po-h-${p.id}`}>
      <div className="card-top">
        <span className="row tight">
          <span className="fmt">Posting</span>
          <span className="tgt">Posted {formatShortDate(p.createdAt, zone)}</span>
        </span>
        <span className="row tight">
          {closed ? <Pill tone="neutral">Closed</Pill> : null}
          {status ? <Pill tone={status.tone}>{status.label}</Pill> : null}
        </span>
      </div>
      <h3 id={`po-h-${p.id}`}>{p.title}</h3>
      {p.about ? <p className="desc">{p.about}</p> : null}
      {p.details ? <p className="desc muted">{p.details}</p> : null}
      {p.requiresApproval ? <p className="note">Staff review interest on this posting and approve or decline it.</p> : null}
      {interest.error ? (
        <p className="err" role="alert">
          {errorText(interest.error)}
        </p>
      ) : null}
      <div className="foot row">
        <button
          type="button"
          className={p.myInterest ? "btn ghost" : "btn"}
          aria-pressed={Boolean(p.myInterest)}
          disabled={interest.isPending || (closed && !p.myInterest)}
          onClick={() => interest.mutate(!p.myInterest)}
        >
          {p.myInterest ? "✓ " : ""}I&apos;m interested
        </button>
        {p.myInterest ? (
          <span className="note">
            {p.myInterest === "interested" ? "Tap again to withdraw." : "Tapping again withdraws and clears the decision."}
          </span>
        ) : closed ? (
          <span className="note">This posting is closed.</span>
        ) : null}
      </div>
    </article>
  );
}

function StaffPostings({ id }: { id?: string }) {
  const postings = usePostings();
  const [editing, setEditing] = useState<Posting | "new" | null>(null);
  const list = postings.data ?? [];
  const target = id ? list.find((p) => p.id === id) : undefined;
  useFlash(target ? `posting-${target.id}` : undefined, Boolean(target));
  const open = list.filter((p) => p.status === "open");
  const closed = list.filter((p) => p.status === "closed");

  return (
    <>
      <PageHead
        title="Internal Postings"
        sub="Roles and opportunities for athletes. Post the details and see who is interested."
        access="Staff and admins"
      />
      {id && postings.data && !target ? <p className="err">That posting is not listed.</p> : null}
      <div className="bar">
        <h2>Postings</h2>
        {editing ? null : (
          <button type="button" className="btn" onClick={() => setEditing("new")}>
            New posting
          </button>
        )}
      </div>
      {editing ? (
        <PostingForm
          key={editing === "new" ? "new" : editing.id}
          posting={editing === "new" ? undefined : editing}
          onDone={() => setEditing(null)}
        />
      ) : null}
      {postings.isPending ? <Loading /> : null}
      <ErrorNote error={postings.error} onRetry={() => void postings.refetch()} />
      {postings.data && list.length === 0 ? <Empty>No postings yet.</Empty> : null}
      {open.length ? (
        <div className="grid">
          {open.map((p) => (
            <StaffCard key={p.id} p={p} onEdit={() => setEditing(p)} />
          ))}
        </div>
      ) : null}
      {closed.length ? (
        <details>
          <summary className="lbl">Closed ({closed.length})</summary>
          <div className="grid" style={{ marginTop: 12 }}>
            {closed.map((p) => (
              <StaffCard key={p.id} p={p} onEdit={() => setEditing(p)} />
            ))}
          </div>
        </details>
      ) : null}
    </>
  );
}

function StaffCard({ p, onEdit }: { p: Posting; onEdit: () => void }) {
  const { zone } = useMe();
  const qc = useQueryClient();
  const toast = useToast();
  const openDesk = useOpenDesk();
  const decide = useMutation({
    mutationFn: (v: { personSub: string; status: "approved" | "declined" }) =>
      api.postingAction(p.id, { action: "decide", ...v }),
    onSuccess: (_, v) => {
      void qc.invalidateQueries({ queryKey: qk.postings });
      toast(v.status === "approved" ? "Approved." : "Declined.");
    },
  });
  const interest = p.interest ?? [];

  return (
    <article className="card" id={`posting-${p.id}`} aria-labelledby={`spo-h-${p.id}`}>
      <div className="card-top">
        <span className="row tight">
          <span className="fmt">Posting</span>
          <span className="tgt">
            Posted {formatShortDate(p.createdAt, zone)} by {p.createdByName}
          </span>
        </span>
        <span className="row tight">
          {p.requiresApproval ? <Pill tone="warn">Approval on</Pill> : null}
          <Pill tone={p.status === "open" ? "ok" : "neutral"}>{p.status === "open" ? "Open" : "Closed"}</Pill>
        </span>
      </div>
      <h3 id={`spo-h-${p.id}`}>{p.title}</h3>
      {p.about ? <p className="desc">{p.about}</p> : null}
      {p.details ? <p className="desc muted">{p.details}</p> : null}
      <div className="stack" style={{ gap: 6 }}>
        <span className="lbl">Interested ({interest.length})</span>
        {interest.length === 0 ? <span className="muted">Nobody yet.</span> : null}
        {interest.map((row) => {
          const s = INTEREST_STATUS[row.status];
          return (
            <div className="who-row" key={row.person.sub}>
              <span className="t">{row.person.name}</span>
              {row.email ? (
                <a className="meta" href={`mailto:${row.email}`}>
                  {row.email}
                </a>
              ) : null}
              <Pill tone={s.tone}>{s.label}</Pill>
              <span className="row acts">
                {p.requiresApproval ? (
                  <>
                    <button
                      type="button"
                      className="btn sm"
                      disabled={decide.isPending || row.status === "approved"}
                      onClick={() => decide.mutate({ personSub: row.person.sub, status: "approved" })}
                    >
                      Approve
                    </button>
                    <button
                      type="button"
                      className="btn ghost sm"
                      disabled={decide.isPending || row.status === "declined"}
                      onClick={() => decide.mutate({ personSub: row.person.sub, status: "declined" })}
                    >
                      Decline
                    </button>
                  </>
                ) : null}
                <button
                  type="button"
                  className="linkbtn"
                  disabled={openDesk.isPending}
                  onClick={() => openDesk.mutate({ desk: "support", personSub: row.person.sub })}
                >
                  Message
                </button>
              </span>
            </div>
          );
        })}
      </div>
      {decide.error || openDesk.error ? (
        <p className="err" role="alert">
          {errorText(decide.error ?? openDesk.error)}
        </p>
      ) : null}
      <div className="foot row">
        <button type="button" className="btn ghost sm" onClick={onEdit}>
          Edit
        </button>
        <span className="meta">{plural(p.interestCount, "athlete")} interested</span>
      </div>
    </article>
  );
}

function PostingForm({ posting, onDone }: { posting?: Posting; onDone: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [title, setTitle] = useState(posting?.title ?? "");
  const [about, setAbout] = useState(posting?.about ?? "");
  const [details, setDetails] = useState(posting?.details ?? "");
  const [requiresApproval, setRequiresApproval] = useState(posting?.requiresApproval ?? false);
  const [status, setStatus] = useState<"open" | "closed">(posting?.status ?? "open");
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: (body: ReturnType<typeof PostingUpsertRequest.parse>) =>
      posting ? api.updatePosting(posting.id, body) : api.createPosting(body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.postings });
      toast(posting ? "Posting saved." : status === "open" ? "Posted. Athletes see it under Internal Postings." : "Saved as closed.");
      onDone();
    },
    onError: (err) => setError(errorText(err)),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!title.trim()) return setError("Give the posting a title.");
    const parsed = PostingUpsertRequest.safeParse({
      title: title.trim(),
      about: about.trim(),
      details: details.trim(),
      requiresApproval,
      status,
    });
    if (!parsed.success) return setError(describeIssues(parsed.error.issues));
    save.mutate(parsed.data);
  };

  return (
    <div className="panel">
      <form onSubmit={submit} aria-labelledby="posting-form-h">
        <h3 id="posting-form-h">{posting ? "Edit posting" : "New posting"}</h3>
        <div className="field">
          <label htmlFor="po-title">Title</label>
          <input id="po-title" required maxLength={100} value={title} onChange={(e) => setTitle(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="po-about">One-line about</label>
          <input
            id="po-about"
            maxLength={200}
            value={about}
            placeholder="What the role is, in one line"
            onChange={(e) => setAbout(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="po-details">Details</label>
          <textarea
            id="po-details"
            rows={5}
            maxLength={5000}
            value={details}
            placeholder="Hours, timing, who it fits, and how it works"
            onChange={(e) => setDetails(e.target.value)}
          />
        </div>
        <Switch checked={requiresApproval} onChange={setRequiresApproval} label="Requires approval" help={`${APPROVAL_HELP}.`} />
        <div className="field" style={{ maxWidth: 260 }}>
          <label htmlFor="po-status">Status</label>
          <select id="po-status" value={status} onChange={(e) => setStatus(e.target.value as "open" | "closed")}>
            <option value="open">Open</option>
            <option value="closed">Closed</option>
          </select>
        </div>
        {error ? (
          <p className="err" role="alert">
            {error}
          </p>
        ) : null}
        <div className="row">
          <button className="btn" type="submit" disabled={save.isPending}>
            {save.isPending ? "Saving…" : posting ? "Save posting" : "Post"}
          </button>
          <button className="btn ghost" type="button" onClick={onDone}>
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}
