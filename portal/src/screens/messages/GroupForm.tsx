/** Admins: create a group, or edit its title, about line and members. */
import { type ConversationDetail, isStaffRole } from "@niltv/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useState } from "react";
import { api, errorText } from "../../api";
import { go } from "../../lib/router";
import { qk, useMembers } from "../../queries";
import { ErrorNote, Loading } from "../../ui/bits";
import { MemberPicker } from "../../ui/MemberPicker";
import { useToast } from "../../ui/Toast";

export function GroupForm({ editId, onDone }: { editId?: string; onDone: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const members = useMembers();
  const existing = useQuery({
    queryKey: qk.conv(editId ?? ""),
    queryFn: () => api.conversation(editId ?? ""),
    enabled: Boolean(editId),
  });

  const [title, setTitle] = useState("");
  const [about, setAbout] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [loadedFor, setLoadedFor] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  // Fill the form once the group loads.
  useEffect(() => {
    if (editId && existing.data && loadedFor !== editId) {
      setTitle(existing.data.title);
      setAbout(existing.data.about);
      setPicked(new Set(existing.data.members.map((m) => m.sub)));
      setLoadedFor(editId);
    }
  }, [editId, existing.data, loadedFor]);

  const save = useMutation({
    mutationFn: () => {
      const body = { title: title.trim(), about: about.trim(), memberSubs: [...picked] };
      return editId ? api.updateGroup(editId, body) : api.createGroup(body);
    },
    onSuccess: (group: ConversationDetail) => {
      qc.setQueryData(qk.conv(group.id), group);
      void qc.invalidateQueries({ queryKey: qk.inbox });
      toast(editId ? "Group saved." : "Group created.");
      onDone();
      go("messages", group.id);
    },
    onError: (err) => setError(errorText(err)),
  });

  // Staff see every group already, so only athletes and guests are picked.
  const pickable = (members.data ?? []).filter((m) => m.status === "active" && !isStaffRole(m.role));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!title.trim()) return setError("Give the group a title.");
    save.mutate();
  };

  if (editId && existing.isPending) return <div className="panel"><Loading what="Loading the group" /></div>;

  return (
    <div className="panel">
      <form onSubmit={submit} aria-labelledby="group-form-h">
        <h3 id="group-form-h">{editId ? "Edit group" : "New group"}</h3>
        <ErrorNote error={existing.error} />
        <div className="two">
          <div className="field">
            <label htmlFor="gf-title">Title</label>
            <input id="gf-title" value={title} maxLength={60} required onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="gf-about">About (one line)</label>
            <input id="gf-about" value={about} maxLength={200} onChange={(e) => setAbout(e.target.value)} />
          </div>
        </div>
        {members.isPending ? <Loading what="Loading the roster" /> : null}
        <ErrorNote error={members.error} onRetry={() => void members.refetch()} />
        {members.data ? (
          <MemberPicker legend="Members" members={pickable} selected={picked} onChange={setPicked} />
        ) : null}
        <p className="hint">Staff see and post in every group, so they are not listed here.</p>
        {error ? (
          <p className="err" role="alert">
            {error}
          </p>
        ) : null}
        <div className="row">
          <button className="btn" type="submit" disabled={save.isPending}>
            {save.isPending ? "Saving…" : editId ? "Save group" : "Create group"}
          </button>
          <button className="btn ghost" type="button" onClick={onDone}>
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}
