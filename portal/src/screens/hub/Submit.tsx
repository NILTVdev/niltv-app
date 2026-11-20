/**
 * The athlete's side of sending content: pick files, watch them upload, add
 * a note and send for review. Files upload as soon as they are picked, so a
 * dropped connection never costs more than the part in flight.
 */
import {
  type Ask,
  MAX_SUBMISSION_BYTES,
  MAX_SUBMISSION_FILES,
  type SubmissionFile,
  submissionTypeAllowed,
} from "@niltv/types";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type ChangeEvent, useEffect, useRef, useState } from "react";
import { api, errorText } from "../../api";
import { formatBytes } from "../../lib/hub";
import { uploadFile } from "../../lib/upload";
import { qk } from "../../queries";
import { useToast } from "../../ui/Toast";
import { openFile } from "./shared";

interface Sending {
  key: string;
  file: File;
  progress: number;
  error?: string;
}

const keyOf = (f: File): string => `${f.name}:${f.size}`;

function refuse(file: File): string | undefined {
  if (file.size === 0) return `${file.name} is empty.`;
  if (file.size > MAX_SUBMISSION_BYTES) return `${file.name} is over 2 GB.`;
  if (!submissionTypeAllowed(file.type)) return `${file.name} is not a video, audio file or photo.`;
  return undefined;
}

export function Submit({ ask, sub, onDone }: { ask: Ask; sub: string; onDone: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [sending, setSending] = useState<Sending[]>([]);
  const [note, setNote] = useState(ask.myClaim?.note ?? "");
  const [problem, setProblem] = useState<string | null>(null);
  const stops = useRef(new Map<string, AbortController>());
  const files = ask.myClaim?.files ?? [];
  const refresh = () => qc.invalidateQueries({ queryKey: qk.asks });

  useEffect(() => {
    const running = stops.current;
    return () => running.forEach((c) => c.abort());
  }, []);

  useEffect(() => {
    if (sending.length === 0) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [sending.length]);

  const patch = (key: string, over: Partial<Sending>) =>
    setSending((list) => list.map((s) => (s.key === key ? { ...s, ...over } : s)));

  const run = async (file: File) => {
    const key = keyOf(file);
    const stop = new AbortController();
    stops.current.set(key, stop);
    patch(key, { progress: 0, error: undefined });
    try {
      await uploadFile(ask.id, file, (progress) => patch(key, { progress }), stop.signal);
      await refresh();
      setSending((list) => list.filter((s) => s.key !== key));
    } catch (err) {
      if (!stop.signal.aborted) patch(key, { error: errorText(err) });
    } finally {
      stops.current.delete(key);
    }
  };

  const pick = (e: ChangeEvent<HTMLInputElement>) => {
    const picked = [...(e.target.files ?? [])];
    e.target.value = "";
    setProblem(null);
    const room = MAX_SUBMISSION_FILES - files.length - sending.length;
    if (picked.length > room) return setProblem(`You can send up to ${MAX_SUBMISSION_FILES} files.`);
    const bad = picked.map(refuse).find(Boolean);
    if (bad) return setProblem(bad);
    const fresh = picked.filter((f) => !sending.some((s) => s.key === keyOf(f)));
    setSending((list) => [...list, ...fresh.map((file) => ({ key: keyOf(file), file, progress: 0 }))]);
    fresh.forEach((f) => void run(f));
  };

  const cancel = (s: Sending) => {
    stops.current.get(s.key)?.abort();
    setSending((list) => list.filter((x) => x.key !== s.key));
  };

  const remove = useMutation({
    mutationFn: (f: SubmissionFile) => api.removeUpload(ask.id, f.id),
    onSuccess: () => refresh(),
  });

  const send = useMutation({
    mutationFn: () => api.askAction(ask.id, { action: "submit", note: note.trim() }),
    onSuccess: async () => {
      await refresh();
      toast("Sent. The team will review it.");
      onDone();
    },
  });

  const open = useMutation({ mutationFn: (f: SubmissionFile) => openFile(ask.id, sub, f.id) });
  const error = remove.error ?? send.error ?? open.error;

  return (
    <div className="stack hub-submit">
      <div className="field">
        <label className="btn ghost sm hub-pick">
          Add files
          <input className="sr-only" type="file" multiple accept="video/*,audio/*,image/*" onChange={pick} />
        </label>
        <span className="hint">Video, audio or photos. Up to 2 GB per file, {MAX_SUBMISSION_FILES} files in all.</span>
      </div>

      {files.length || sending.length ? (
        <ul className="hub-files">
          {files.map((f) => (
            <li key={f.id}>
              <button type="button" className="linkbtn" onClick={() => open.mutate(f)}>
                {f.name}
              </button>
              <span className="meta">{formatBytes(f.size)}</span>
              <button type="button" className="linkbtn" disabled={remove.isPending} onClick={() => remove.mutate(f)}>
                Remove
              </button>
            </li>
          ))}
          {sending.map((s) => (
            <li key={s.key}>
              <span className="t">{s.file.name}</span>
              {s.error ? (
                <>
                  <span className="err" role="alert">
                    Stopped. {s.error}
                  </span>
                  <button type="button" className="linkbtn" onClick={() => void run(s.file)}>
                    Resume
                  </button>
                </>
              ) : (
                <span className="meta">{Math.floor(s.progress * 100)}%</span>
              )}
              <button type="button" className="linkbtn" onClick={() => cancel(s)}>
                Cancel
              </button>
              <progress max={1} value={s.progress} aria-label={`Uploading ${s.file.name}`} />
            </li>
          ))}
        </ul>
      ) : null}

      <div className="field">
        <label htmlFor={`note-${ask.id}`}>Note for the team (optional)</label>
        <textarea id={`note-${ask.id}`} rows={2} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />
      </div>

      {problem ? (
        <p className="err" role="alert">
          {problem}
        </p>
      ) : null}
      {error ? (
        <p className="err" role="alert">
          {errorText(error)}
        </p>
      ) : null}

      <div className="row">
        <button
          type="button"
          className="btn"
          disabled={send.isPending || files.length === 0 || sending.length > 0}
          onClick={() => send.mutate()}
        >
          {send.isPending ? "Sending…" : "Send for review"}
        </button>
        <button type="button" className="btn ghost" onClick={onDone}>
          Close
        </button>
      </div>
    </div>
  );
}
