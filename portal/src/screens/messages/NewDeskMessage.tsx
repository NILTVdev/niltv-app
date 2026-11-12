/** Staff: start (or find) a desk thread with an athlete or guest. */
import { DESK_LABELS, type Desk, desksFor, isStaffRole } from "@niltv/types";
import { type FormEvent, useMemo, useState } from "react";
import { errorText } from "../../api";
import { campusName, ROLE_LABELS } from "../../lib/format";
import { useMembers, useOpenDesk } from "../../queries";
import { ErrorNote, Loading } from "../../ui/bits";
import { useMe } from "../../ui/me";

export function NewDeskMessage({ onDone, presetSub }: { onDone: () => void; presetSub?: string }) {
  const { member } = useMe();
  const members = useMembers();
  const open = useOpenDesk();
  const [personSub, setPersonSub] = useState(presetSub ?? "");
  const [desk, setDesk] = useState<Desk | "">("");

  const people = useMemo(
    () =>
      (members.data ?? [])
        .filter((m) => m.status === "active" && !isStaffRole(m.role))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [members.data],
  );
  const person = people.find((p) => p.sub === personSub);
  // Desks I answer that this person may also use.
  const desks = person ? desksFor(member.role).filter((d) => desksFor(person.role).includes(d)) : desksFor(member.role);
  const chosenDesk = desk && desks.includes(desk) ? desk : desks[0];

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!person || !chosenDesk) return;
    open.mutate({ desk: chosenDesk, personSub: person.sub }, { onSuccess: onDone });
  };

  return (
    <div className="panel">
      <form onSubmit={submit} aria-labelledby="new-msg-h">
        <h3 id="new-msg-h">New message</h3>
        <p className="note">Messages go through a desk. The person sees the desk name, not yours.</p>
        {members.isPending ? <Loading what="Loading the roster" /> : null}
        <ErrorNote error={members.error} onRetry={() => void members.refetch()} />
        <div className="two">
          <div className="field">
            <label htmlFor="nm-person">Athlete or guest</label>
            <select id="nm-person" value={personSub} required onChange={(e) => setPersonSub(e.target.value)}>
              <option value="">Pick a person</option>
              {people.map((p) => (
                <option key={p.sub} value={p.sub}>
                  {p.name} ({ROLE_LABELS[p.role]}
                  {p.role === "athlete" && p.campus ? `, ${campusName(p.campus)}` : ""})
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="nm-desk">Desk</label>
            <select id="nm-desk" value={chosenDesk ?? ""} onChange={(e) => setDesk(e.target.value as Desk)}>
              {desks.map((d) => (
                <option key={d} value={d}>
                  {DESK_LABELS[d]}
                </option>
              ))}
            </select>
          </div>
        </div>
        {open.error ? (
          <p className="err" role="alert">
            {errorText(open.error)}
          </p>
        ) : null}
        <div className="row">
          <button className="btn" type="submit" disabled={!person || !chosenDesk || open.isPending}>
            {open.isPending ? "Opening…" : "Open the thread"}
          </button>
          <button className="btn ghost" type="button" onClick={onDone}>
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}
