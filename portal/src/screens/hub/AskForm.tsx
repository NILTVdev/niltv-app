/** Post or edit an ask: title, format, one description, who it is for, and optional approval. */
import {
  type Ask,
  type AskAudience,
  AskUpsertRequest,
  CAMPUS_CHANNELS,
  PORTAL_SPORTS,
} from "@niltv/types";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { api, errorText } from "../../api";
import { CAMPUS_OPTIONS, describeIssues } from "../../lib/format";
import { qk } from "../../queries";
import { Switch } from "../../ui/bits";
import { useToast } from "../../ui/Toast";

export function AskForm({ ask, onDone }: { ask?: Ask; onDone: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const a = ask?.audience;
  const [title, setTitle] = useState(ask?.title ?? "");
  const [format, setFormat] = useState<"short" | "long">(ask?.format ?? "short");
  const [description, setDescription] = useState(ask?.description ?? "");
  const [audType, setAudType] = useState<AskAudience["type"]>(a?.type ?? "everyone");
  const [campus, setCampus] = useState(a?.type === "campus" ? a.campus : "");
  const [sport, setSport] = useState(a?.type === "sport" ? a.sport : "");
  const [requiresApproval, setRequiresApproval] = useState(ask?.requiresApproval ?? false);
  const [status, setStatus] = useState<"open" | "closed">(ask?.status ?? "open");
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: (body: ReturnType<typeof AskUpsertRequest.parse>) => (ask ? api.updateAsk(ask.id, body) : api.createAsk(body)),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.asks });
      toast(ask ? "Ask saved." : status === "open" ? "Posted. Athletes see it in the Content Hub." : "Saved as closed.");
      onDone();
    },
    onError: (err) => setError(errorText(err)),
  });

  const audience = (): AskAudience | string => {
    if (audType === "campus") return campus ? { type: "campus", campus } : "Pick a campus.";
    if (audType === "sport") return sport ? { type: "sport", sport } : "Pick a sport.";
    return { type: "everyone" };
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!title.trim()) return setError("Give the ask a title.");
    const target = audience();
    if (typeof target === "string") return setError(target);
    const parsed = AskUpsertRequest.safeParse({
      title: title.trim(),
      format,
      description: description.trim(),
      audience: target,
      requiresApproval,
      status,
    });
    if (!parsed.success) return setError(describeIssues(parsed.error.issues));
    save.mutate(parsed.data);
  };

  return (
    <div className="panel">
      <form onSubmit={submit} aria-labelledby="ask-form-h">
        <h3 id="ask-form-h">{ask ? "Edit ask" : "New ask"}</h3>
        <div className="field">
          <label htmlFor="ask-title">Title</label>
          <input id="ask-title" required maxLength={100} value={title} onChange={(e) => setTitle(e.target.value)} />
        </div>
        <div className="field" style={{ maxWidth: 260 }}>
          <label htmlFor="ask-format">Format</label>
          <select id="ask-format" value={format} onChange={(e) => setFormat(e.target.value as "short" | "long")}>
            <option value="short">Short form</option>
            <option value="long">Long form</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="ask-desc">Description</label>
          <textarea
            id="ask-desc"
            rows={5}
            maxLength={2000}
            value={description}
            placeholder="What to film, how long, and anything to avoid"
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>
        <div className="field" style={{ maxWidth: 260 }}>
          <label htmlFor="ask-aud">Who it is for</label>
          <select id="ask-aud" value={audType} onChange={(e) => setAudType(e.target.value as AskAudience["type"])}>
            <option value="everyone">Every athlete</option>
            <option value="campus">One campus</option>
            <option value="sport">One sport</option>
          </select>
        </div>
        {audType === "campus" ? (
          <div className="field" style={{ maxWidth: 260 }}>
            <label htmlFor="ask-campus">Campus</label>
            <select id="ask-campus" value={campus} onChange={(e) => setCampus(e.target.value)}>
              <option value="">Pick a campus</option>
              {CAMPUS_OPTIONS.map((c) => (
                <option key={c.slug} value={c.slug}>
                  {c.name}
                </option>
              ))}
            </select>
            {campus && !CAMPUS_CHANNELS[campus] ? <span className="hint">Unknown campus: {campus}</span> : null}
          </div>
        ) : null}
        {audType === "sport" ? (
          <div className="field" style={{ maxWidth: 260 }}>
            <label htmlFor="ask-sport">Sport</label>
            <select id="ask-sport" value={sport} onChange={(e) => setSport(e.target.value)}>
              <option value="">Pick a sport</option>
              {PORTAL_SPORTS.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        <Switch
          checked={requiresApproval}
          onChange={setRequiresApproval}
          label="Approve claims"
          help="Staff approve each athlete before they start."
        />
        <div className="field" style={{ maxWidth: 260 }}>
          <label htmlFor="ask-status">Status</label>
          <select id="ask-status" value={status} onChange={(e) => setStatus(e.target.value as "open" | "closed")}>
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
            {save.isPending ? "Saving…" : ask ? "Save ask" : "Post"}
          </button>
          <button className="btn ghost" type="button" onClick={onDone}>
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}
