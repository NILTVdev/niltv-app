/**
 * Events page: event + entries CRUD, break-glass status
 * override, and the vote-audit export. Saving an event re-syncs its two
 * lifecycle one-shots server-side (design §6.5) — dates here ARE the
 * schedule.
 */
import type { EventEntity, EventStatus } from "@niltv/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FormEvent, useState } from "react";
import { api } from "./api";

type EventForm = {
  id?: string;
  title: string;
  /** datetime-local values (local time; converted to ISO on submit) */
  startsAt: string;
  endsAt: string;
  prize: string;
  partners: string;
  blurb: string;
};

const EMPTY: EventForm = { title: "", startsAt: "", endsAt: "", prize: "", partners: "", blurb: "" };

/** ISO → the local-time `yyyy-MM-ddThh:mm` a datetime-local input needs. */
function toLocalInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const STATUS_LABEL: Record<EventStatus, string> = {
  upcoming: "Upcoming",
  live: "● LIVE",
  ended: "Ended",
};

export function EventsPage() {
  const queryClient = useQueryClient();
  const eventsQ = useQuery({ queryKey: ["events"], queryFn: api.listEvents });
  const [form, setForm] = useState<EventForm>(EMPTY);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ["events"] });

  const saveMut = useMutation({
    mutationFn: (f: EventForm) =>
      api.upsertEvent({
        id: f.id,
        title: f.title.trim(),
        startsAt: new Date(f.startsAt).toISOString(),
        endsAt: new Date(f.endsAt).toISOString(),
        prize: f.prize.trim() || undefined,
        partners: f.partners
          .split(",")
          .map((p) => p.trim())
          .filter(Boolean),
        blurb: f.blurb.trim() || undefined,
      }),
    onSuccess: (saved) => {
      setForm(EMPTY);
      setSelectedId(saved.id);
      invalidate();
    },
  });

  const windowInvalid =
    form.startsAt !== "" && form.endsAt !== "" && new Date(form.endsAt) <= new Date(form.startsAt);

  function edit(ev: EventEntity) {
    setForm({
      id: ev.id,
      title: ev.title,
      startsAt: toLocalInput(ev.startsAt),
      endsAt: toLocalInput(ev.endsAt),
      prize: ev.prize ?? "",
      partners: ev.partners.join(", "),
      blurb: ev.blurb ?? "",
    });
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!windowInvalid) saveMut.mutate(form);
  }

  const items = eventsQ.data?.items ?? [];
  const set = (patch: Partial<EventForm>) => setForm((f) => ({ ...f, ...patch }));

  return (
    <>
      {eventsQ.error && <div className="error-banner">{eventsQ.error.message}</div>}

      <h2>Events</h2>
      {eventsQ.isPending ? (
        <p className="hint">Loading events…</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Title</th>
              <th>Status</th>
              <th>Voting window (local)</th>
              <th>Prize</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 && (
              <tr>
                <td colSpan={5} className="empty">
                  No events yet — create the first one below.
                </td>
              </tr>
            )}
            {items.map((ev) => (
              <tr
                key={ev.id}
                className="selectable"
                onClick={() => setSelectedId(selectedId === ev.id ? null : ev.id)}
              >
                <td>
                  {ev.title} <span className="hint">{ev.id}</span>
                </td>
                <td>{STATUS_LABEL[ev.status]}</td>
                <td>
                  {new Date(ev.startsAt).toLocaleString()} → {new Date(ev.endsAt).toLocaleString()}
                </td>
                <td>{ev.prize ?? "—"}</td>
                <td>
                  <button
                    className="btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      edit(ev);
                    }}
                  >
                    Edit
                  </button>{" "}
                  <button
                    className="btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      setSelectedId(selectedId === ev.id ? null : ev.id);
                    }}
                  >
                    {selectedId === ev.id ? "Close" : "Entries / tools"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {selectedId && <EventTools eventId={selectedId} onChanged={invalidate} />}

      <h2>{form.id ? "Edit event" : "New event"}</h2>
      <form className="form-card" onSubmit={submit}>
        {saveMut.error && <div className="error-banner">{saveMut.error.message}</div>}
        <div className="form-row">
          <label className="field">
            <span>Title</span>
            <input
              type="text"
              value={form.title}
              onChange={(e) => set({ title: e.target.value })}
              required
            />
          </label>
          <label className="field">
            <span>Prize (e.g. $10,000 grand prize)</span>
            <input type="text" value={form.prize} onChange={(e) => set({ prize: e.target.value })} />
          </label>
        </div>
        <div className="form-row">
          <label className="field">
            <span>Voting opens (your local time)</span>
            <input
              type="datetime-local"
              value={form.startsAt}
              onChange={(e) => set({ startsAt: e.target.value })}
              required
            />
          </label>
          <label className="field">
            <span>Voting closes (your local time)</span>
            <input
              type="datetime-local"
              value={form.endsAt}
              onChange={(e) => set({ endsAt: e.target.value })}
              required
            />
          </label>
        </div>
        <label className="field">
          <span>Partners (comma-separated)</span>
          <input type="text" value={form.partners} onChange={(e) => set({ partners: e.target.value })} />
        </label>
        <label className="field">
          <span>Card blurb</span>
          <input type="text" value={form.blurb} onChange={(e) => set({ blurb: e.target.value })} />
        </label>
        {windowInvalid && <div className="error-banner">Voting must close after it opens.</div>}
        <div className="form-actions">
          <button
            className="btn primary"
            type="submit"
            disabled={saveMut.isPending || !form.title.trim() || windowInvalid}
          >
            {saveMut.isPending ? "Saving…" : form.id ? "Save changes" : "Create event"}
          </button>
          {form.id && (
            <button className="btn" type="button" onClick={() => setForm(EMPTY)}>
              Cancel edit
            </button>
          )}
        </div>
        <p className="hint">
          Saving (re)schedules the automatic go-live and close — status flips itself at these
          times.
        </p>
      </form>
    </>
  );
}

/** Entries roster + status override + audit export for one event. */
function EventTools({ eventId, onChanged }: { eventId: string; onChanged: () => void }) {
  const queryClient = useQueryClient();
  const detailQ = useQuery({ queryKey: ["event", eventId], queryFn: () => api.eventDetail(eventId) });
  const profilesQ = useQuery({ queryKey: ["profiles"], queryFn: api.listProfiles });
  const [athleteId, setAthleteId] = useState("");
  const [auditionId, setAuditionId] = useState("");
  const [auditError, setAuditError] = useState<string | null>(null);

  const refetch = () => {
    void queryClient.invalidateQueries({ queryKey: ["event", eventId] });
    onChanged();
  };

  const addMut = useMutation({
    mutationFn: () =>
      api.upsertEntry(eventId, {
        athleteId,
        auditionContentId: auditionId.trim() || undefined,
      }),
    onSuccess: () => {
      setAthleteId("");
      setAuditionId("");
      refetch();
    },
  });
  const removeMut = useMutation({
    mutationFn: (entryId: string) => api.deleteEntry(eventId, entryId),
    onSuccess: refetch,
  });
  const statusMut = useMutation({
    mutationFn: (status: EventStatus) => api.setEventStatus(eventId, status),
    onSuccess: refetch,
  });

  async function downloadAudit() {
    setAuditError(null);
    try {
      const audit = await api.eventAudit(eventId);
      const blob = new Blob([JSON.stringify(audit, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${eventId}-audit-${audit.generatedAt.slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
      if (!audit.countersMatch) {
        setAuditError("Audit downloaded — WARNING: counters do not match the vote fact rows.");
      }
    } catch (err) {
      setAuditError(err instanceof Error ? err.message : "Audit export failed.");
    }
  }

  const profileName = (id: string) =>
    profilesQ.data?.items.find((p) => p.id === id)?.name ?? id;
  const detail = detailQ.data;

  return (
    <div className="form-card">
      {detailQ.error && <div className="error-banner">{detailQ.error.message}</div>}
      {!detail ? (
        <p className="hint">Loading event…</p>
      ) : (
        <>
          <h3>
            {detail.event.title} — {STATUS_LABEL[detail.event.status]}
          </h3>

          <h4>Finalists</h4>
          <table>
            <thead>
              <tr>
                <th>Athlete</th>
                <th>Audition clip</th>
                <th>Votes</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {detail.entries.length === 0 && (
                <tr>
                  <td colSpan={4} className="empty">
                    No finalists yet.
                  </td>
                </tr>
              )}
              {detail.entries.map((entry) => (
                <tr key={entry.id}>
                  <td>{profileName(entry.athleteId)}</td>
                  <td>{entry.auditionContentId ?? "—"}</td>
                  <td>{entry.votes}</td>
                  <td>
                    <button
                      className="btn"
                      disabled={removeMut.isPending}
                      onClick={() => removeMut.mutate(entry.id)}
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {addMut.error && <div className="error-banner">{addMut.error.message}</div>}
          <div className="form-row">
            <label className="field">
              <span>Add finalist</span>
              <select value={athleteId} onChange={(e) => setAthleteId(e.target.value)}>
                <option value="">Select an athlete…</option>
                {(profilesQ.data?.items ?? []).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} — {p.school}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Audition content id (optional)</span>
              <input
                type="text"
                value={auditionId}
                onChange={(e) => setAuditionId(e.target.value)}
              />
            </label>
            <div className="form-actions">
              <button
                className="btn primary"
                type="button"
                disabled={!athleteId || addMut.isPending}
                onClick={() => addMut.mutate()}
              >
                {addMut.isPending ? "Adding…" : "Add"}
              </button>
            </div>
          </div>

          <h4>Status override (break-glass)</h4>
          {statusMut.error && <div className="error-banner">{statusMut.error.message}</div>}
          <p className="hint">
            Normally the scheduler flips status at the window boundaries — use these only in an
            emergency. Ending an event freezes its leaderboard.
          </p>
          <div className="form-actions">
            {(["upcoming", "live", "ended"] as const).map((s) => (
              <button
                key={s}
                className="btn"
                disabled={statusMut.isPending || detail.event.status === s}
                onClick={() => {
                  if (window.confirm(`Force this event to "${s}" now?`)) statusMut.mutate(s);
                }}
              >
                Force {s}
              </button>
            ))}
          </div>

          <h4>Audit</h4>
          {auditError && <div className="error-banner">{auditError}</div>}
          <div className="form-actions">
            <button className="btn" type="button" onClick={() => void downloadAudit()}>
              Download vote audit (JSON)
            </button>
          </div>
        </>
      )}
    </div>
  );
}
