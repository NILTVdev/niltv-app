/**
 * Team & access (admins): every member's role, status and desks; add staff;
 * portal settings; and the access matrix straight from PORTAL_PERMISSIONS.
 */
import {
  DESK_LABELS,
  Desk as DeskEnum,
  type Desk,
  MemberAddRequest,
  type MemberListResponse,
  PORTAL_PERMISSIONS,
  type PortalMember,
  type PortalMemberStatus,
  type PortalPermission,
  PortalRole as RoleEnum,
  type PortalRole,
  desksFor,
  isStaffRole,
  portalCan,
} from "@niltv/types";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useMemo, useState } from "react";
import { api, errorText } from "../api";
import { describeIssues, MEMBER_STATUS, PERMISSION_LABELS, ROLE_LABELS } from "../lib/format";
import { patchMember, qk, useMembers } from "../queries";
import { Check, Empty, ErrorNote, Loading, PageHead, Pill } from "../ui/bits";
import { useMe } from "../ui/me";
import { useToast } from "../ui/Toast";
import { SettingsForm } from "./team/SettingsForm";

type RoleFilter = "all" | "team" | "athlete" | "guest";

export function Team() {
  const { member: me } = useMe();
  const members = useMembers();
  const [filter, setFilter] = useState<RoleFilter>("all");
  const [q, setQ] = useState("");
  const [adding, setAdding] = useState(false);

  const all = members.data ?? [];
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return all
      .filter((m) =>
        filter === "all" ? true : filter === "team" ? isStaffRole(m.role) : m.role === filter,
      )
      .filter((m) => !needle || `${m.name} ${m.email}`.toLowerCase().includes(needle))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [all, filter, q]);

  const count = (f: RoleFilter) =>
    f === "all" ? all.length : f === "team" ? all.filter((m) => isStaffRole(m.role)).length : all.filter((m) => m.role === f).length;

  return (
    <>
      <PageHead
        title="Team & access"
        sub="Who can do what. Roles are checked on the server, not just hidden in the menu."
        access="Admins only"
      />
      <div className="bar">
        <h2>Members</h2>
        {adding ? null : (
          <button type="button" className="btn" onClick={() => setAdding(true)}>
            Add staff
          </button>
        )}
      </div>
      {adding ? <AddStaff onDone={() => setAdding(false)} /> : null}
      <div className="chips" role="group" aria-label="Show members">
        {(
          [
            ["team", "Staff and admins"],
            ["athlete", "Athletes"],
            ["guest", "Guests"],
            ["all", "Everyone"],
          ] as const
        ).map(([f, label]) => (
          <button key={f} type="button" className="chip" aria-pressed={filter === f} onClick={() => setFilter(f)}>
            {label} ({count(f)})
          </button>
        ))}
      </div>
      <div className="field" style={{ maxWidth: 420 }}>
        <label htmlFor="tm-q">Search</label>
        <input id="tm-q" type="search" value={q} placeholder="Name or email" onChange={(e) => setQ(e.target.value)} />
      </div>
      {members.isPending ? <Loading /> : null}
      <ErrorNote error={members.error} onRetry={() => void members.refetch()} />
      {members.data && shown.length === 0 ? <Empty>Nobody matches.</Empty> : null}
      {shown.length ? (
        <div className="tablewrap">
          <table className="members">
            <thead>
              <tr>
                <th scope="col">Member</th>
                <th scope="col">Role</th>
                <th scope="col">Status</th>
                <th scope="col">Desks</th>
                <th scope="col">
                  <span className="sr-only">Save</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.map((m) => (
                <MemberRow key={`${m.sub}:${m.updatedAt ?? ""}`} m={m} />
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {shown.some((m) => m.sub === me.sub) ? <p className="hint">You cannot change your own role or status.</p> : null}

      <SettingsForm />
      <AccessMatrix />
    </>
  );
}

const sameDesks = (a: readonly Desk[], b: readonly Desk[]): boolean => a.length === b.length && a.every((d) => b.includes(d));

function MemberRow({ m }: { m: PortalMember }) {
  const { member: me } = useMe();
  const qc = useQueryClient();
  const toast = useToast();
  const self = m.sub === me.sub;
  const [role, setRole] = useState<PortalRole>(m.role);
  const [status, setStatus] = useState<PortalMemberStatus>(m.status);
  const [desks, setDesks] = useState<Desk[]>(m.desks);

  const allowedDesks = isStaffRole(role) ? desksFor(role) : [];
  const nextDesks = desks.filter((d) => allowedDesks.includes(d));
  const dirty = role !== m.role || status !== m.status || !sameDesks(nextDesks, isStaffRole(m.role) ? m.desks : []);

  const save = useMutation({
    mutationFn: () =>
      api.updateMember(m.sub, {
        ...(role !== m.role ? { role } : {}),
        ...(status !== m.status ? { status } : {}),
        ...(isStaffRole(role) ? { desks: nextDesks } : {}),
      }),
    onSuccess: (next) => {
      patchMember(qc, next);
      void qc.invalidateQueries({ queryKey: qk.members });
      toast(`Saved ${next.name}.`);
    },
  });

  const statusPill = MEMBER_STATUS[m.status];

  return (
    <tr>
      <td>
        <div className="t">
          {m.name} {self ? <span className="muted">(you)</span> : null}
        </div>
        <div className="c">{m.email}</div>
      </td>
      <td data-label="Role">
        <label className="sr-only" htmlFor={`tr-${m.sub}`}>
          Role for {m.name}
        </label>
        <select id={`tr-${m.sub}`} value={role} disabled={self} onChange={(e) => setRole(e.target.value as PortalRole)}>
          {RoleEnum.options.map((r) => (
            <option key={r} value={r}>
              {ROLE_LABELS[r]}
            </option>
          ))}
        </select>
      </td>
      <td data-label="Status">
        <div>
          <label className="sr-only" htmlFor={`ts-${m.sub}`}>
            Status for {m.name}
          </label>
          <select
            id={`ts-${m.sub}`}
            value={status}
            disabled={self}
            onChange={(e) => setStatus(e.target.value as PortalMemberStatus)}
          >
            <option value="active">Active</option>
            <option value="ready">Waiting</option>
            <option value="disabled">No access</option>
          </select>
          {status === m.status ? null : (
            <div className="c">
              Was <Pill tone={statusPill.tone}>{statusPill.label}</Pill>
            </div>
          )}
        </div>
      </td>
      <td data-label="Desks">
        {isStaffRole(role) ? (
          <div className="desks">
            {DeskEnum.options.map((d) => (
              <Check
                key={d}
                checked={desks.includes(d)}
                disabled={!allowedDesks.includes(d)}
                onChange={(on) => setDesks((cur) => (on ? [...new Set([...cur, d])] : cur.filter((x) => x !== d)))}
              >
                {DESK_LABELS[d]}
              </Check>
            ))}
          </div>
        ) : (
          <span className="muted">None</span>
        )}
      </td>
      <td>
        <button type="button" className="btn" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? "Saving…" : "Save"}
        </button>
        {save.error ? (
          <p className="err" role="alert" style={{ marginTop: 6 }}>
            {errorText(save.error)}
          </p>
        ) : null}
      </td>
    </tr>
  );
}

function AddStaff({ onDone }: { onDone: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState<"staff" | "admin">("staff");
  const [desks, setDesks] = useState<Desk[]>(["content", "support"]);
  const [error, setError] = useState<string | null>(null);
  const allowed = desksFor(role);

  const add = useMutation({
    mutationFn: (input: ReturnType<typeof MemberAddRequest.parse>) => api.addMember(input),
    onSuccess: (member) => {
      qc.setQueryData<MemberListResponse>(qk.members, (old) =>
        old ? { members: [...old.members.filter((m) => m.sub !== member.sub), member] } : old,
      );
      void qc.invalidateQueries({ queryKey: qk.members });
      toast(`${member.name} is now ${ROLE_LABELS[member.role].toLowerCase()}.`);
      onDone();
    },
    onError: (err) => setError(errorText(err)),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const parsed = MemberAddRequest.safeParse({
      email: email.trim(),
      role,
      ...(name.trim() ? { name: name.trim() } : {}),
      desks: desks.filter((d) => allowed.includes(d)),
    });
    if (!parsed.success) return setError(describeIssues(parsed.error.issues));
    add.mutate(parsed.data);
  };

  return (
    <div className="panel">
      <form onSubmit={submit} noValidate aria-labelledby="add-staff-h">
        <h3 id="add-staff-h">Add staff</h3>
        <p className="note">They need a niltv.com account first. Use the email they signed up with.</p>
        <div className="two">
          <div className="field">
            <label htmlFor="as-email">Email</label>
            <input id="as-email" type="email" required autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="as-name">Name (optional)</label>
            <input id="as-name" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
          </div>
        </div>
        <div className="rolerow">
          <div className="field">
            <label htmlFor="as-role">Role</label>
            <select id="as-role" value={role} onChange={(e) => setRole(e.target.value as "staff" | "admin")}>
              <option value="staff">Staff</option>
              <option value="admin">Admin</option>
            </select>
          </div>
          <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="lbl">Desks</legend>
            <div className="desks">
              {DeskEnum.options.map((d) => (
                <Check
                  key={d}
                  checked={desks.includes(d) && allowed.includes(d)}
                  disabled={!allowed.includes(d)}
                  onChange={(on) => setDesks((cur) => (on ? [...new Set([...cur, d])] : cur.filter((x) => x !== d)))}
                >
                  {DESK_LABELS[d]}
                </Check>
              ))}
            </div>
            {!allowed.includes("payments") ? <span className="hint">The Payments desk is admin only.</span> : null}
          </fieldset>
        </div>
        {error ? (
          <p className="err" role="alert">
            {error}
          </p>
        ) : null}
        <div className="row">
          <button className="btn" type="submit" disabled={add.isPending}>
            {add.isPending ? "Adding…" : "Add"}
          </button>
          <button className="btn ghost" type="button" onClick={onDone}>
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}

function AccessMatrix() {
  const roles = RoleEnum.options;
  const perms = Object.keys(PORTAL_PERMISSIONS) as PortalPermission[];
  return (
    <section className="stack" aria-labelledby="matrix-h">
      <div className="bar">
        <h2 id="matrix-h">Who can do what</h2>
      </div>
      <div className="tablewrap">
        <table className="matrix">
          <caption className="sr-only">Permissions by role</caption>
          <thead>
            <tr>
              <th scope="col">Action</th>
              {roles.map((r) => (
                <th scope="col" key={r}>
                  {ROLE_LABELS[r]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {perms.map((p) => (
              <tr key={p}>
                <th scope="row">{PERMISSION_LABELS[p]}</th>
                {roles.map((r) => (
                  <td key={r} data-label={ROLE_LABELS[r]}>
                    {portalCan(r, p) ? <span className="yes">Yes</span> : <span className="no">No</span>}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
