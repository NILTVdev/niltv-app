/**
 * Guests (staff): outside collaborators. Add someone who already has a
 * niltv.com account, or take their access away.
 */
import { MemberAddRequest, type MemberListResponse, type PortalMember } from "@niltv/types";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { api, errorText } from "../api";
import { describeIssues, MEMBER_STATUS } from "../lib/format";
import { formatSeen, formatShortDate } from "../lib/time";
import { patchMember, qk, useMembers, useOpenDesk } from "../queries";
import { Empty, ErrorNote, Loading, PageHead, Pill } from "../ui/bits";
import { useMe } from "../ui/me";
import { useToast } from "../ui/Toast";

export function Guests() {
  const members = useMembers();
  const [adding, setAdding] = useState(false);
  const guests = (members.data ?? [])
    .filter((m) => m.role === "guest")
    .sort((a, b) => (a.status === b.status ? a.name.localeCompare(b.name) : a.status === "active" ? -1 : 1));

  return (
    <>
      <PageHead
        title="Guests"
        sub="Outside collaborators: streamers, producers, partner contacts. They only see the groups and events you add them to."
        access="Staff and admins"
      />
      <div className="panel">
        <p className="note">
          Guests never see the roster, campus or sport channels, postings, or payments. They message the Content team
          and Athlete support desks. Staff see every group a guest is in.
        </p>
      </div>
      <div className="bar">
        <h2>All guests</h2>
        {adding ? null : (
          <button type="button" className="btn" onClick={() => setAdding(true)}>
            Add guest
          </button>
        )}
      </div>
      {adding ? <AddGuest onDone={() => setAdding(false)} /> : null}
      {members.isPending ? <Loading /> : null}
      <ErrorNote error={members.error} onRetry={() => void members.refetch()} />
      {members.data && guests.length === 0 ? <Empty>No guests yet.</Empty> : null}
      {guests.length ? (
        <div className="tablewrap">
          <table className="roster">
            <thead>
              <tr>
                <th scope="col">Guest</th>
                <th scope="col">Helping with</th>
                <th scope="col">Status</th>
                <th scope="col">Last seen</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {guests.map((g) => (
                <GuestRow key={g.sub} g={g} />
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </>
  );
}

function GuestRow({ g }: { g: PortalMember }) {
  const { zone } = useMe();
  const qc = useQueryClient();
  const toast = useToast();
  const openDesk = useOpenDesk();
  const update = useMutation({
    mutationFn: (status: "active" | "disabled") => api.updateMember(g.sub, { status }),
    onSuccess: (next) => {
      patchMember(qc, next);
      void qc.invalidateQueries({ queryKey: qk.members });
      toast(next.status === "active" ? `${next.name} has access again.` : `${next.name} was removed.`);
    },
  });
  const s = MEMBER_STATUS[g.status];

  return (
    <tr>
      <td>
        <div className="t">{g.name}</div>
        <div className="c">
          {g.email} · added {formatShortDate(g.createdAt, zone)}
        </div>
      </td>
      <td data-label="Helping with">{g.note ?? <span className="muted">Not set</span>}</td>
      <td data-label="Status">
        <Pill tone={s.tone}>{g.status === "disabled" ? "Removed" : s.label}</Pill>
      </td>
      <td className="num" data-label="Last seen">
        {formatSeen(g.lastSeenAt, zone)}
      </td>
      <td>
        <div className="row">
          {g.status === "active" ? (
            <>
              <button
                type="button"
                className="btn ghost sm"
                disabled={openDesk.isPending}
                aria-label={`Message ${g.name} from the Content team`}
                onClick={() => openDesk.mutate({ desk: "content", personSub: g.sub })}
              >
                Message
              </button>
              <button
                type="button"
                className="btn danger sm"
                disabled={update.isPending}
                aria-label={`Remove ${g.name}`}
                onClick={() => {
                  if (window.confirm(`Remove ${g.name}? They lose portal access and leave every group.`)) update.mutate("disabled");
                }}
              >
                Remove
              </button>
            </>
          ) : (
            <button
              type="button"
              className="btn ghost sm"
              disabled={update.isPending}
              aria-label={`Give ${g.name} access again`}
              onClick={() => update.mutate("active")}
            >
              Restore
            </button>
          )}
        </div>
        {update.error || openDesk.error ? (
          <p className="err" role="alert" style={{ marginTop: 6 }}>
            {errorText(update.error ?? openDesk.error)}
          </p>
        ) : null}
      </td>
    </tr>
  );
}

function AddGuest({ onDone }: { onDone: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  const add = useMutation({
    mutationFn: (input: ReturnType<typeof MemberAddRequest.parse>) => api.addMember(input),
    onSuccess: (member) => {
      qc.setQueryData<MemberListResponse>(qk.members, (old) =>
        old ? { members: [...old.members.filter((m) => m.sub !== member.sub), member] } : old,
      );
      void qc.invalidateQueries({ queryKey: qk.members });
      toast(`${member.name} can sign in now.`);
      onDone();
    },
    // NO_ACCOUNT and CONFLICT messages come from the server; show them as they are.
    onError: (err) => setError(errorText(err)),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const parsed = MemberAddRequest.safeParse({
      email: email.trim(),
      role: "guest",
      ...(name.trim() ? { name: name.trim() } : {}),
      ...(note.trim() ? { note: note.trim() } : {}),
    });
    if (!parsed.success) return setError(describeIssues(parsed.error.issues));
    add.mutate(parsed.data);
  };

  return (
    <div className="panel">
      <form onSubmit={submit} noValidate aria-labelledby="add-guest-h">
        <h3 id="add-guest-h">Add guest</h3>
        <p className="note">They need a niltv.com account first. Use the email they signed up with.</p>
        <div className="two">
          <div className="field">
            <label htmlFor="ag-email">Email</label>
            <input id="ag-email" type="email" required value={email} autoComplete="off" onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="ag-name">Name (optional)</label>
            <input id="ag-name" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="field full">
            <label htmlFor="ag-note">What they are helping with (optional)</label>
            <input
              id="ag-note"
              maxLength={120}
              value={note}
              placeholder="Gaming stream partner"
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
        </div>
        {error ? (
          <p className="err" role="alert">
            {error}
          </p>
        ) : null}
        <div className="row">
          <button className="btn" type="submit" disabled={add.isPending}>
            {add.isPending ? "Adding…" : "Add guest"}
          </button>
          <button className="btn ghost" type="button" onClick={onDone}>
            Cancel
          </button>
        </div>
        <p className="hint">Add them to a group in Messages so they can talk with athletes.</p>
      </form>
    </div>
  );
}
