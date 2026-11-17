/** Post or edit an ask: title, format, one description, who it is for, and optional approval. */
import {
  ASK_IMAGE_TYPES,
  type Ask,
  type AskAudience,
  type AskImageRequest,
  AskUpsertRequest,
  CAMPUS_CHANNELS,
  MAX_ASK_IMAGE_BYTES,
} from "@niltv/types";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useRef, useState } from "react";
import { api, errorText } from "../../api";
import { CAMPUS_COMBO, SPORT_COMBO } from "../../lib/combo";
import { describeIssues } from "../../lib/format";
import { insertAt } from "../../lib/hub";
import { qk } from "../../queries";
import { Switch, Tabs } from "../../ui/bits";
import { ComboBox } from "../../ui/ComboBox";
import { Markdown } from "../../ui/Markdown";
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
  const [descTab, setDescTab] = useState<"write" | "preview">("write");
  const [images, setImages] = useState<Record<string, string>>(ask?.images ?? {});
  const [adding, setAdding] = useState(false);
  const descRef = useRef<HTMLTextAreaElement>(null);

  const save = useMutation({
    mutationFn: (body: ReturnType<typeof AskUpsertRequest.parse>) => (ask ? api.updateAsk(ask.id, body) : api.createAsk(body)),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.asks });
      toast(ask ? "Ask saved." : status === "open" ? "Posted. Athletes see it in the Content Hub." : "Saved as closed.");
      onDone();
    },
    onError: (err) => setError(errorText(err)),
  });

  const addImage = (file: File) => {
    setError(null);
    if (!(ASK_IMAGE_TYPES as readonly string[]).includes(file.type) || file.size > MAX_ASK_IMAGE_BYTES) {
      return setError("Use a JPG, PNG, WebP or GIF up to 10 MB.");
    }
    const box = descRef.current;
    const start = box?.selectionStart ?? description.length;
    const end = box?.selectionEnd ?? description.length;
    setAdding(true);
    void (async () => {
      try {
        const { id, uploadUrl, url } = await api.askImage({ type: file.type as AskImageRequest["type"], size: file.size });
        const put = await fetch(uploadUrl, { method: "PUT", headers: { "content-type": file.type }, body: file });
        if (!put.ok) throw new Error("The image did not upload. Try again.");
        setImages((all) => ({ ...all, [id]: url }));
        setDescription((text) => insertAt(text, start, end, `![image](portal-image:${id})`).value);
      } catch (err) {
        setError(errorText(err));
      } finally {
        setAdding(false);
      }
    })();
  };

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
        <div className="field ask-desc">
          <span className="lbl" id="ask-desc-l">
            Description
          </span>
          <Tabs
            idBase="ask-desc"
            label="Description"
            value={descTab}
            onChange={setDescTab}
            tabs={[
              { key: "write", label: "Write" },
              { key: "preview", label: "Preview" },
            ]}
          />
          <div id="ask-desc-panel" role="tabpanel" aria-labelledby={`ask-desc-${descTab}`}>
            {descTab === "write" ? (
              <textarea
                id="ask-desc"
                ref={descRef}
                aria-labelledby="ask-desc-l"
                rows={8}
                maxLength={5000}
                value={description}
                placeholder="What to film, how long, and anything to avoid"
                onChange={(e) => setDescription(e.target.value)}
                onPaste={(e) => {
                  const file = [...e.clipboardData.files].find((f) => f.type.startsWith("image/"));
                  if (!file) return;
                  e.preventDefault();
                  addImage(file);
                }}
                onDrop={(e) => {
                  const file = [...e.dataTransfer.files].find((f) => f.type.startsWith("image/"));
                  if (!file) return;
                  e.preventDefault();
                  addImage(file);
                }}
              />
            ) : description.trim() ? (
              <div className="md-preview">
                <Markdown text={description} images={images} />
              </div>
            ) : (
              <p className="note md-preview">Nothing to preview yet.</p>
            )}
          </div>
          <div className="row">
            <label className="btn ghost sm hub-pick">
              {adding ? "Adding…" : "Add image"}
              <input
                className="sr-only"
                type="file"
                accept={ASK_IMAGE_TYPES.join(",")}
                disabled={adding}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (file) addImage(file);
                }}
              />
            </label>
            <span className="hint">Markdown works here: **bold**, lists, links, tables. Paste or drop an image too.</span>
          </div>
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
            <ComboBox id="ask-campus" value={campus} onChange={setCampus} options={CAMPUS_COMBO} placeholder="Type or pick a campus" />
            {campus && !CAMPUS_CHANNELS[campus] ? <span className="hint">Unknown campus: {campus}</span> : null}
          </div>
        ) : null}
        {audType === "sport" ? (
          <div className="field" style={{ maxWidth: 260 }}>
            <label htmlFor="ask-sport">Sport</label>
            <ComboBox id="ask-sport" value={sport} onChange={setSport} options={SPORT_COMBO} placeholder="Type or pick a sport" />
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
