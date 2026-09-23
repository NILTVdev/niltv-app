import type { Channel, Content, Profile, TranscodeStatus } from "@niltv/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FormEvent, useEffect, useState } from "react";
import { api, putToS3 } from "./api";

function fmtDate(iso?: string): string {
  return iso ? new Date(iso).toLocaleString() : "—";
}

function StatusChip({ status }: { status: TranscodeStatus }) {
  return <span className={`chip ${status}`}>{status}</span>;
}

export function ContentPage() {
  const channelsQ = useQuery({
    queryKey: ["channels"],
    queryFn: api.listChannels,
    staleTime: 5 * 60_000,
  });
  const profilesQ = useQuery({ queryKey: ["profiles"], queryFn: api.listProfiles });
  const contentQ = useQuery({
    queryKey: ["content"],
    queryFn: api.listContent,
    // keep the table fresh while MediaConvert is working
    refetchInterval: (query) =>
      query.state.data?.items.some((i) => i.transcodeStatus === "processing") ? 30_000 : false,
  });

  const [openId, setOpenId] = useState<string | null>(null);

  const channels = channelsQ.data?.channels ?? [];
  const profiles = profilesQ.data?.items ?? [];
  const items = contentQ.data?.items ?? [];
  const channelName = (id: string) => channels.find((c) => c.id === id)?.name ?? id;
  const creatorName = (id: string) => profiles.find((p) => p.id === id)?.name ?? id;
  const openRow = items.find((i) => i.id === openId);

  const loadError = contentQ.error ?? channelsQ.error ?? profilesQ.error;

  return (
    <>
      {loadError && <div className="error-banner">{loadError.message}</div>}

      <h2>Content</h2>
      {contentQ.isPending ? (
        <p className="hint">Loading content…</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Title</th>
              <th>Channel</th>
              <th>Creator</th>
              <th>Status</th>
              <th>Published</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 && (
              <tr>
                <td colSpan={6} className="empty">
                  No content yet — create the first row below.
                </td>
              </tr>
            )}
            {items.map((row) => (
              <tr key={row.id} className="selectable" onClick={() => setOpenId(row.id)}>
                <td>{row.title}</td>
                <td>{channelName(row.channelId)}</td>
                <td>{creatorName(row.athleteId)}</td>
                <td>
                  <StatusChip status={row.transcodeStatus} />
                </td>
                <td>{fmtDate(row.publishedAt)}</td>
                <td>
                  <button
                    className="btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      setOpenId(row.id);
                    }}
                  >
                    Manage
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>New content</h2>
      <NewContentForm channels={channels} profiles={profiles} />

      {openRow && (
        <ContentDrawer
          row={openRow}
          channelName={channelName(openRow.channelId)}
          creatorName={creatorName(openRow.athleteId)}
          onClose={() => setOpenId(null)}
        />
      )}
    </>
  );
}

/* ── New content ─────────────────────────────────────────────────────────── */

function NewContentForm({ channels, profiles }: { channels: Channel[]; profiles: Profile[] }) {
  const queryClient = useQueryClient();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [channelId, setChannelId] = useState("");
  const [athleteId, setAthleteId] = useState("");
  const [rights, setRights] = useState(false);

  const createMut = useMutation({
    mutationFn: () =>
      api.upsertContent({ title, description, channelId, athleteId, rightsConfirmed: rights }),
    onSuccess: (created) => {
      setTitle("");
      setDescription("");
      setChannelId("");
      setAthleteId("");
      setRights(false);
      void queryClient.invalidateQueries({ queryKey: ["content"] });
      void created; // row appears in the refreshed table; open its drawer to upload
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    createMut.mutate();
  }

  return (
    <form className="form-card" onSubmit={submit}>
      {createMut.error && <div className="error-banner">{createMut.error.message}</div>}
      <label className="field">
        <span>Title</span>
        <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} required />
      </label>
      <label className="field">
        <span>Description</span>
        <textarea
          rows={3}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </label>
      <div className="form-row">
        <label className="field">
          <span>Channel</span>
          <select value={channelId} onChange={(e) => setChannelId(e.target.value)} required>
            <option value="">Select channel…</option>
            {channels.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Athlete (creator)</span>
          <select value={athleteId} onChange={(e) => setAthleteId(e.target.value)} required>
            <option value="">Select athlete…</option>
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} — {p.school}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="check">
        <input type="checkbox" checked={rights} onChange={(e) => setRights(e.target.checked)} />
        Rights confirmed (NILTV may distribute this video)
      </label>
      <div className="form-actions">
        <button
          className="btn primary"
          type="submit"
          disabled={createMut.isPending || !title.trim() || !channelId || !athleteId}
        >
          {createMut.isPending ? "Creating…" : "Create content"}
        </button>
      </div>
    </form>
  );
}

/* ── Detail drawer: upload → transcode → publish ─────────────────────────── */

type UploadPhase =
  | { kind: "idle" }
  | { kind: "requesting" }
  | { kind: "uploading"; pct: number }
  | { kind: "waiting" } // PUT done — transcode pipeline takes over
  | { kind: "error"; message: string };

function ContentDrawer({
  row,
  channelName,
  creatorName,
  onClose,
}: {
  row: Content;
  channelName: string;
  creatorName: string;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [upload, setUpload] = useState<UploadPhase>({ kind: "idle" });

  const statusQ = useQuery({
    queryKey: ["content-status", row.id],
    queryFn: () => api.contentStatus(row.id),
    // poll every 5s while the pipeline is running
    refetchInterval: (query) => {
      const s = query.state.data?.transcodeStatus;
      return s === "uploading" || s === "processing" ? 5_000 : false;
    },
  });

  const status: TranscodeStatus = statusQ.data?.transcodeStatus ?? row.transcodeStatus;

  // when the pipeline advances, the table row is stale — refresh it
  const liveStatus = statusQ.data?.transcodeStatus;
  useEffect(() => {
    if (liveStatus && liveStatus !== row.transcodeStatus) {
      void queryClient.invalidateQueries({ queryKey: ["content"] });
    }
  }, [liveStatus, row.transcodeStatus, queryClient]);

  async function startUpload() {
    if (!file) return;
    try {
      setUpload({ kind: "requesting" });
      const { uploadUrl } = await api.uploadUrl(row.id, file.type || "application/octet-stream");
      setUpload({ kind: "uploading", pct: 0 });
      await putToS3(uploadUrl, file, (pct) => setUpload({ kind: "uploading", pct }));
      setUpload({ kind: "waiting" });
      setFile(null);
      void queryClient.invalidateQueries({ queryKey: ["content-status", row.id] });
      void queryClient.invalidateQueries({ queryKey: ["content"] });
    } catch (e) {
      setUpload({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }

  const rightsMut = useMutation({
    mutationFn: (next: boolean) =>
      api.upsertContent({
        id: row.id,
        title: row.title,
        channelId: row.channelId,
        athleteId: row.athleteId,
        description: row.description,
        rightsConfirmed: next,
      }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["content"] }),
  });

  const publishMut = useMutation({
    mutationFn: () => api.publish(row.id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["content"] });
      void queryClient.invalidateQueries({ queryKey: ["content-status", row.id] });
    },
  });

  const unpublishMut = useMutation({
    mutationFn: () => api.unpublish(row.id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["content"] });
      void queryClient.invalidateQueries({ queryKey: ["content-status", row.id] });
    },
  });

  const isPublished = status === "published";
  const uploadBusy = upload.kind === "requesting" || upload.kind === "uploading";
  const canPublish = status === "ready" && row.rightsConfirmed && !publishMut.isPending;

  return (
    <>
      <div className="drawer-scrim" onClick={onClose} />
      <div className="drawer">
        <button className="close" onClick={onClose} aria-label="Close">
          ×
        </button>
        <h3>{row.title}</h3>
        <p className="meta">
          {channelName} · {creatorName}
        </p>

        <section>
          <h4>Transcode status</h4>
          <div className="status-line">
            <StatusChip status={status} />
            {statusQ.data?.durationSec !== undefined && (
              <span className="hint">{Math.round(statusQ.data.durationSec)}s</span>
            )}
          </div>
          {status === "failed" && statusQ.data?.transcodeError && (
            <div className="error-banner">{statusQ.data.transcodeError}</div>
          )}
          {statusQ.data?.playbackPath && (
            <p className="hint">Playback: {statusQ.data.playbackPath}</p>
          )}
          {statusQ.error && <div className="error-banner">{statusQ.error.message}</div>}
        </section>

        <section>
          <h4>Video upload</h4>
          {isPublished ? (
            <p className="hint">Unpublish before replacing the video.</p>
          ) : (
            <>
              <input
                type="file"
                accept="video/*"
                disabled={uploadBusy}
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
              <div className="form-actions">
                <button
                  className="btn primary"
                  disabled={!file || uploadBusy}
                  onClick={() => void startUpload()}
                >
                  {upload.kind === "requesting" ? "Preparing…" : "Upload"}
                </button>
              </div>
              {upload.kind === "uploading" && (
                <>
                  <div className="progress">
                    <div style={{ width: `${upload.pct}%` }} />
                  </div>
                  <p className="hint">Uploading… {upload.pct}%</p>
                </>
              )}
              {upload.kind === "waiting" && (
                <p className="hint">Upload complete — waiting for the transcode to finish.</p>
              )}
              {upload.kind === "error" && <div className="error-banner">{upload.message}</div>}
            </>
          )}
        </section>

        <section>
          <h4>Rights</h4>
          <label className="check">
            <input
              type="checkbox"
              checked={row.rightsConfirmed}
              disabled={rightsMut.isPending}
              onChange={(e) => rightsMut.mutate(e.target.checked)}
            />
            Rights confirmed (NILTV may distribute this video)
          </label>
          {rightsMut.error && <div className="error-banner">{rightsMut.error.message}</div>}
        </section>

        <section>
          <h4>Publish</h4>
          {isPublished ? (
            <>
              <p className="hint">Published {fmtDate(row.publishedAt)}.</p>
              <button
                className="btn danger"
                disabled={unpublishMut.isPending}
                onClick={() => unpublishMut.mutate()}
              >
                {unpublishMut.isPending ? "Unpublishing…" : "Unpublish"}
              </button>
              {unpublishMut.error && (
                <div className="error-banner">{unpublishMut.error.message}</div>
              )}
            </>
          ) : (
            <>
              <button
                className="btn primary"
                disabled={!canPublish}
                onClick={() => publishMut.mutate()}
              >
                {publishMut.isPending ? "Publishing…" : "Publish"}
              </button>
              {status !== "ready" && (
                <p className="hint">The video must finish processing before publish.</p>
              )}
              {!row.rightsConfirmed && (
                <p className="hint">Rights must be confirmed before publish.</p>
              )}
              {publishMut.error && <div className="error-banner">{publishMut.error.message}</div>}
            </>
          )}
        </section>
      </div>
    </>
  );
}
