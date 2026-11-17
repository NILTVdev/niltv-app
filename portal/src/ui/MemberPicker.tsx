/** Pick people from the roster: search, tick, see how many are picked. */
import type { PortalMember } from "@niltv/types";
import { useId, useMemo, useState } from "react";
import { campusName, ROLE_LABELS } from "../lib/format";
import { Check } from "./bits";

export function MemberPicker({
  legend,
  members,
  selected,
  onChange,
}: {
  legend: string;
  members: readonly PortalMember[];
  selected: ReadonlySet<string>;
  onChange: (next: Set<string>) => void;
}) {
  const [q, setQ] = useState("");
  const searchId = useId();
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return [...members]
      .filter((m) => !needle || `${m.name} ${m.email} ${m.sport ?? ""} ${campusName(m.campus)}`.toLowerCase().includes(needle))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [members, q]);

  const toggle = (sub: string, on: boolean) => {
    const next = new Set(selected);
    if (on) next.add(sub);
    else next.delete(sub);
    onChange(next);
  };

  return (
    <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
      <legend className="lbl">
        {legend} <span className="muted">({selected.size} picked)</span>
      </legend>
      <label htmlFor={searchId} className="sr-only">
        Search people
      </label>
      <input
        id={searchId}
        type="search"
        placeholder="Name, email, sport or campus"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      <div className="row">
        <button type="button" className="linkbtn" onClick={() => onChange(new Set([...selected, ...shown.map((m) => m.sub)]))}>
          Pick all shown
        </button>
        <button type="button" className="linkbtn" onClick={() => onChange(new Set())}>
          Clear
        </button>
      </div>
      <div className="pick">
        {shown.length === 0 ? <span className="muted">Nobody matches.</span> : null}
        {shown.map((m) => (
          <Check key={m.sub} checked={selected.has(m.sub)} onChange={(on) => toggle(m.sub, on)}>
            {m.name}{" "}
            <span className="muted">
              {ROLE_LABELS[m.role]}
              {m.role === "athlete" && (m.campus || m.sport)
                ? ` · ${[campusName(m.campus), m.sport].filter(Boolean).join(" · ")}`
                : m.note
                  ? ` · ${m.note}`
                  : ""}
            </span>
          </Check>
        ))}
      </div>
    </fieldset>
  );
}
