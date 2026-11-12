/** Small shared pieces: page header, pills, avatars, empty and error states, tabs. */
import type { PortalRole } from "@niltv/types";
import { type ReactNode, useId } from "react";
import { errorText } from "../api";
import { initials, type Tone } from "../lib/format";

export function PageHead({ title, sub, access }: { title: string; sub?: ReactNode; access?: string }) {
  return (
    <header className="head">
      <div>
        <h1>{title}</h1>
        {sub ? <p>{sub}</p> : null}
      </div>
      {access ? (
        <span className="access">
          Visible to: <b>{access}</b>
        </span>
      ) : null}
    </header>
  );
}

export const PRIVACY_URL = "https://niltv.com/legal/privacy/";
export const TERMS_URL = "https://niltv.com/legal/terms/";

/** The small print under sign-in and no-access. */
export const LegalLinks = () => (
  <p className="legal">
    Trouble signing in? <a href="mailto:support@niltv.com">support@niltv.com</a>
    <br />
    <a href={PRIVACY_URL} target="_blank" rel="noopener noreferrer">
      Privacy Policy
    </a>{" "}
    ·{" "}
    <a href={TERMS_URL} target="_blank" rel="noopener noreferrer">
      Terms of Use
    </a>
  </p>
);

/** Privacy Policy and Terms of Use, for the sidebar, the More sheet, Account and Help. */
export const PolicyLinks = () => (
  <p className="policy">
    <a href={PRIVACY_URL} target="_blank" rel="noopener noreferrer">
      Privacy Policy
    </a>{" "}
    ·{" "}
    <a href={TERMS_URL} target="_blank" rel="noopener noreferrer">
      Terms of Use
    </a>
  </p>
);

export const Pill = ({ tone, children }: { tone: Tone; children: ReactNode }) => (
  <span className={`pill ${tone}`}>{children}</span>
);

/** Initials in a circle. Staff posts show the team mark. */
export function Avatar({ name, role, team = false }: { name: string; role?: PortalRole; team?: boolean }) {
  if (team || role === "staff" || role === "admin") {
    return (
      <span className="av staff" aria-hidden="true">
        NT
      </span>
    );
  }
  return (
    <span className={`av${role === "guest" ? " guest" : ""}`} aria-hidden="true">
      {initials(name)}
    </span>
  );
}

export const Empty = ({ children }: { children: ReactNode }) => <div className="empty">{children}</div>;

export const Loading = ({ what = "Loading" }: { what?: string }) => (
  <p className="loading" role="status">
    {what}…
  </p>
);

/** An error as one readable line, with an optional retry. Never raw JSON. */
export function ErrorNote({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  if (!error) return null;
  return (
    <div className="err" role="alert">
      {errorText(error)}{" "}
      {onRetry ? (
        <button type="button" className="linkbtn" onClick={onRetry}>
          Try again
        </button>
      ) : null}
    </div>
  );
}

export interface TabDef<K extends string> {
  key: K;
  label: string;
  count?: number;
}

/** A tablist; the panel below it should carry aria-labelledby={`${id}-${key}`}. */
export function Tabs<K extends string>({
  tabs,
  value,
  onChange,
  label,
  idBase,
}: {
  tabs: TabDef<K>[];
  value: K;
  onChange: (key: K) => void;
  label: string;
  idBase: string;
}) {
  const move = (dir: 1 | -1) => {
    const i = tabs.findIndex((t) => t.key === value);
    const next = tabs[(i + dir + tabs.length) % tabs.length];
    if (next) {
      onChange(next.key);
      document.getElementById(`${idBase}-${next.key}`)?.focus();
    }
  };
  return (
    <div
      className="tabs"
      role="tablist"
      aria-label={label}
      onKeyDown={(e) => {
        if (e.key === "ArrowRight") move(1);
        if (e.key === "ArrowLeft") move(-1);
      }}
    >
      {tabs.map((t) => (
        <button
          key={t.key}
          id={`${idBase}-${t.key}`}
          type="button"
          role="tab"
          aria-selected={t.key === value}
          aria-controls={`${idBase}-panel`}
          tabIndex={t.key === value ? 0 : -1}
          onClick={() => onChange(t.key)}
        >
          {t.label}
          {t.count !== undefined ? <span className="n">{t.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

/** A labelled on/off switch (a styled checkbox). */
export function Switch({
  checked,
  onChange,
  label,
  help,
  disabled,
}: {
  checked: boolean;
  onChange: (on: boolean) => void;
  label: ReactNode;
  help?: ReactNode;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <label className="check" htmlFor={id}>
      <input
        id={id}
        type="checkbox"
        className="sw"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>
        {label}
        {help ? <span className="help">{help}</span> : null}
      </span>
    </label>
  );
}

/** A plain checkbox with its label. */
export function Check({
  checked,
  onChange,
  children,
  disabled,
}: {
  checked: boolean;
  onChange: (on: boolean) => void;
  children: ReactNode;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <label className="check" htmlFor={id}>
      <input id={id} type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span>{children}</span>
    </label>
  );
}
