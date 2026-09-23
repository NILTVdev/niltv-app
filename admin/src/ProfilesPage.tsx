import type { Profile } from "@niltv/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FormEvent, useState } from "react";
import { api } from "./api";

type ProfileForm = {
  id?: string;
  name: string;
  handle: string;
  school: string;
  sport: string;
  bio: string;
  athlete: boolean;
  ambassador: boolean;
  rank: string;
  /** carried through on edit so an upsert doesn't wipe fields this form doesn't cover */
  socials?: Profile["socials"];
  brands?: string[];
};

const EMPTY: ProfileForm = {
  name: "",
  handle: "",
  school: "",
  sport: "",
  bio: "",
  athlete: true,
  ambassador: false,
  rank: "",
};

export function ProfilesPage() {
  const queryClient = useQueryClient();
  const profilesQ = useQuery({ queryKey: ["profiles"], queryFn: api.listProfiles });
  const [form, setForm] = useState<ProfileForm>(EMPTY);

  const rankValue = form.rank.trim() === "" ? undefined : Number(form.rank);
  const rankInvalid =
    rankValue !== undefined && (!Number.isInteger(rankValue) || rankValue < 1);

  const saveMut = useMutation({
    mutationFn: (f: ProfileForm) =>
      api.upsertProfile({
        id: f.id,
        name: f.name.trim(),
        handle: f.handle.trim(),
        school: f.school,
        sport: f.sport,
        bio: f.bio || undefined,
        statuses: [
          ...(f.athlete ? (["athlete"] as const) : []),
          ...(f.ambassador ? (["ambassador"] as const) : []),
        ],
        ambassadorRank: f.ambassador && rankValue !== undefined ? rankValue : undefined,
        socials: f.socials,
        brands: f.brands,
      }),
    onSuccess: () => {
      setForm(EMPTY);
      void queryClient.invalidateQueries({ queryKey: ["profiles"] });
    },
  });

  function edit(p: Profile) {
    setForm({
      id: p.id,
      name: p.name,
      handle: p.handle,
      school: p.school,
      sport: p.sport,
      bio: p.bio,
      athlete: p.statuses.includes("athlete"),
      ambassador: p.statuses.includes("ambassador"),
      rank: p.ambassadorRank ? String(p.ambassadorRank) : "",
      socials: p.socials,
      brands: p.brands,
    });
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!rankInvalid) saveMut.mutate(form);
  }

  const items = profilesQ.data?.items ?? [];
  const set = (patch: Partial<ProfileForm>) => setForm((f) => ({ ...f, ...patch }));

  return (
    <>
      {profilesQ.error && <div className="error-banner">{profilesQ.error.message}</div>}

      <h2>Profiles</h2>
      {profilesQ.isPending ? (
        <p className="hint">Loading profiles…</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>School</th>
              <th>Sport</th>
              <th>Statuses</th>
              <th>Rank</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 && (
              <tr>
                <td colSpan={6} className="empty">
                  No profiles yet — create the first one below.
                </td>
              </tr>
            )}
            {items.map((p) => (
              <tr key={p.id} className="selectable" onClick={() => edit(p)}>
                <td>
                  {p.name} <span className="hint">@{p.handle}</span>
                </td>
                <td>{p.school}</td>
                <td>{p.sport}</td>
                <td>{p.statuses.join(", ") || "—"}</td>
                <td>{p.ambassadorRank ?? "—"}</td>
                <td>
                  <button
                    className="btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      edit(p);
                    }}
                  >
                    Edit
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>{form.id ? "Edit profile" : "New profile"}</h2>
      <form className="form-card" onSubmit={submit}>
        {saveMut.error && <div className="error-banner">{saveMut.error.message}</div>}
        <div className="form-row">
          <label className="field">
            <span>Name</span>
            <input
              type="text"
              value={form.name}
              onChange={(e) => set({ name: e.target.value })}
              required
            />
          </label>
          <label className="field">
            <span>Handle</span>
            <input
              type="text"
              value={form.handle}
              onChange={(e) => set({ handle: e.target.value })}
              required
            />
          </label>
        </div>
        <div className="form-row">
          <label className="field">
            <span>School</span>
            <input
              type="text"
              value={form.school}
              onChange={(e) => set({ school: e.target.value })}
            />
          </label>
          <label className="field">
            <span>Sport</span>
            <input
              type="text"
              value={form.sport}
              onChange={(e) => set({ sport: e.target.value })}
            />
          </label>
        </div>
        <label className="field">
          <span>Bio</span>
          <textarea rows={3} value={form.bio} onChange={(e) => set({ bio: e.target.value })} />
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={form.athlete}
            onChange={(e) => set({ athlete: e.target.checked })}
          />
          Athlete
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={form.ambassador}
            onChange={(e) => set({ ambassador: e.target.checked })}
          />
          Ambassador
        </label>
        {form.ambassador && (
          <label className="field">
            <span>Ambassador rank (optional)</span>
            <input
              type="number"
              min={1}
              step={1}
              value={form.rank}
              onChange={(e) => set({ rank: e.target.value })}
            />
          </label>
        )}
        {rankInvalid && <div className="error-banner">Rank must be a positive whole number.</div>}
        <div className="form-actions">
          <button
            className="btn primary"
            type="submit"
            disabled={saveMut.isPending || !form.name.trim() || !form.handle.trim() || rankInvalid}
          >
            {saveMut.isPending ? "Saving…" : form.id ? "Save changes" : "Create profile"}
          </button>
          {form.id && (
            <button className="btn" type="button" onClick={() => setForm(EMPTY)}>
              Cancel edit
            </button>
          )}
        </div>
      </form>
    </>
  );
}
