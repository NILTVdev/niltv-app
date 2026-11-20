/**
 * Staff: create or edit an event. One time makes a set event; two or more
 * ask invitees to pick a time. Times are typed in the viewer's zone and sent in UTC.
 */
import {
  type Audience,
  CAMPUS_CHANNELS,
  EVENT_KIND_LABELS,
  EventUpsertRequest,
  type PortalEvent,
  type PortalEventKind,
} from "@niltv/types";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { api, errorText } from "../../api";
import { CAMPUS_COMBO, SPORT_COMBO } from "../../lib/combo";
import { describeIssues, isHttpUrl } from "../../lib/format";
import { ComboBox } from "../../ui/ComboBox";
import { utcToWallTime, wallTimeToUtc, zoneAbbr } from "../../lib/time";
import { qk, useInbox, useMembers } from "../../queries";
import { ErrorNote } from "../../ui/bits";
import { useMe } from "../../ui/me";
import { MemberPicker } from "../../ui/MemberPicker";
import { useToast } from "../../ui/Toast";

type AudienceType = Audience["type"];
interface TimeRow {
  key: number;
  start: string;
  end: string;
}

const MAX_TIMES = 12;
let rowKey = 1;
const newRow = (start = "", end = ""): TimeRow => ({ key: rowKey++, start, end });

export function EventForm({ event, onDone }: { event?: PortalEvent; onDone: () => void }) {
  const { zone, notifications } = useMe();
  const reach = notifications.activityEmails || notifications.webPush;
  const qc = useQueryClient();
  const toast = useToast();
  const inbox = useInbox();
  const members = useMembers();

  const a = event?.audience;
  const [title, setTitle] = useState(event?.title ?? "");
  const [kind, setKind] = useState<PortalEventKind>(event?.kind ?? "gaming");
  const [description, setDescription] = useState(event?.description ?? "");
  const [location, setLocation] = useState(event?.location ?? "");
  const [streamUrl, setStreamUrl] = useState(event?.streamUrl ?? "");
  const [audType, setAudType] = useState<AudienceType>(a?.type ?? "everyone");
  const [campus, setCampus] = useState(a?.type === "campus" ? a.campus : "");
  const [sport, setSport] = useState(a?.type === "sport" ? a.sport : "");
  const [groupId, setGroupId] = useState(a?.type === "group" ? a.convId : "");
  const [people, setPeople] = useState<Set<string>>(new Set(a?.type === "people" ? a.subs : []));
  const [times, setTimes] = useState<TimeRow[]>(() =>
    event?.options.length
      ? event.options.map((o) => newRow(utcToWallTime(o.startsAt, zone), o.endsAt ? utcToWallTime(o.endsAt, zone) : ""))
      : [newRow()],
  );
  const [error, setError] = useState<string | null>(null);

  const groups = (inbox.data ?? []).filter((c) => c.kind === "group").sort((x, y) => x.title.localeCompare(y.title));
  const activeMembers = (members.data ?? []).filter((m) => m.status === "active");
  const filled = times.filter((t) => t.start);

  const save = useMutation({
    mutationFn: (body: ReturnType<typeof EventUpsertRequest.parse>) =>
      event ? api.updateEvent(event.id, body) : api.createEvent(body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.events });
      toast(
        event
          ? "Event saved."
          : filled.length === 1
            ? `Event created.${reach ? " Invitees are notified." : ""}`
            : `Sent.${reach ? " Invitees are notified." : " Invitees see it in the portal."}`,
      );
      onDone();
    },
    onError: (err) => setError(errorText(err)),
  });

  const buildAudience = (): Audience | string => {
    switch (audType) {
      case "everyone":
        return { type: "everyone" };
      case "campus":
        return campus ? { type: "campus", campus } : "Pick a campus.";
      case "sport":
        return sport ? { type: "sport", sport } : "Pick a sport.";
      case "group":
        return groupId ? { type: "group", convId: groupId } : "Pick a group.";
      case "people":
        return people.size ? { type: "people", subs: [...people] } : "Pick at least one person.";
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!title.trim()) return setError("Give the event a title.");
    const audience = buildAudience();
    if (typeof audience === "string") return setError(audience);
    if (filled.length === 0) return setError("Add at least one time.");
    const options: { startsAt: string; endsAt?: string }[] = [];
    for (const [i, row] of filled.entries()) {
      const start = wallTimeToUtc(row.start, zone);
      if (!start) return setError(`Time ${i + 1} needs a date and time.`);
      const end = row.end ? wallTimeToUtc(row.end, zone) : undefined;
      if (row.end && !end) return setError(`Time ${i + 1} has an end that is not a date and time.`);
      if (end && end <= start) return setError(`Time ${i + 1} ends before it starts.`);
      options.push({ startsAt: start.toISOString(), ...(end ? { endsAt: end.toISOString() } : {}) });
    }
    const link = streamUrl.trim();
    if (link && !isHttpUrl(link)) return setError("The stream link must be a full link starting with https://.");
    const parsed = EventUpsertRequest.safeParse({
      title: title.trim(),
      kind,
      description: description.trim(),
      ...(location.trim() ? { location: location.trim() } : {}),
      ...(link ? { streamUrl: link } : {}),
      audience,
      options,
    });
    if (!parsed.success) return setError(describeIssues(parsed.error.issues));
    save.mutate(parsed.data);
  };

  const setRow = (key: number, patch: Partial<TimeRow>) =>
    setTimes((rows) => rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  const abbr = zoneAbbr(new Date(), zone);

  return (
    <div className="panel">
      <form onSubmit={submit} aria-labelledby="event-form-h" noValidate>
        <h3 id="event-form-h">{event ? "Edit event" : "New event"}</h3>
        <div className="two">
          <div className="field full">
            <label htmlFor="ev-title">Title</label>
            <input id="ev-title" value={title} maxLength={100} required onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="ev-kind">Kind</label>
            <select id="ev-kind" value={kind} onChange={(e) => setKind(e.target.value as PortalEventKind)}>
              {Object.entries(EVENT_KIND_LABELS).map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="ev-aud">Who is invited</label>
            <select id="ev-aud" value={audType} onChange={(e) => setAudType(e.target.value as AudienceType)}>
              <option value="everyone">Every athlete</option>
              <option value="campus">One campus</option>
              <option value="sport">One sport</option>
              <option value="group">A group</option>
              <option value="people">Specific people</option>
            </select>
          </div>
          {audType === "campus" ? (
            <div className="field full">
              <label htmlFor="ev-campus">Campus</label>
              <ComboBox id="ev-campus" value={campus} onChange={setCampus} options={CAMPUS_COMBO} placeholder="Type or pick a campus" />
              {campus && !CAMPUS_CHANNELS[campus] ? <span className="hint">Unknown campus: {campus}</span> : null}
            </div>
          ) : null}
          {audType === "sport" ? (
            <div className="field full">
              <label htmlFor="ev-sport">Sport</label>
              <ComboBox id="ev-sport" value={sport} onChange={setSport} options={SPORT_COMBO} placeholder="Type or pick a sport" />
            </div>
          ) : null}
          {audType === "group" ? (
            <div className="field full">
              <label htmlFor="ev-group">Group</label>
              <select id="ev-group" value={groupId} onChange={(e) => setGroupId(e.target.value)}>
                <option value="">Pick a group</option>
                {groups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.title}
                  </option>
                ))}
              </select>
              <ErrorNote error={inbox.error} />
              <span className="hint">Group events follow the group: people added later are invited too.</span>
            </div>
          ) : null}
          {audType === "people" ? (
            <div className="full">
              <ErrorNote error={members.error} />
              <MemberPicker legend="People" members={activeMembers} selected={people} onChange={setPeople} />
            </div>
          ) : null}
          <div className="field full">
            <label htmlFor="ev-desc">Description</label>
            <textarea
              id="ev-desc"
              rows={3}
              maxLength={2000}
              value={description}
              placeholder="What it is and anything to bring"
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="ev-loc">Location (optional)</label>
            <input id="ev-loc" maxLength={200} value={location} onChange={(e) => setLocation(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="ev-stream">Stream link (optional)</label>
            <input
              id="ev-stream"
              type="url"
              inputMode="url"
              maxLength={500}
              placeholder="https://"
              value={streamUrl}
              onChange={(e) => setStreamUrl(e.target.value)}
            />
          </div>
        </div>

        <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="lbl">Times ({abbr})</legend>
          {times.map((row, i) => (
            <div className="timerow" key={row.key}>
              <div className="field">
                <label htmlFor={`ev-start-${row.key}`}>Time {i + 1} starts</label>
                <input
                  id={`ev-start-${row.key}`}
                  type="datetime-local"
                  value={row.start}
                  onChange={(e) => setRow(row.key, { start: e.target.value })}
                />
              </div>
              <div className="field">
                <label htmlFor={`ev-end-${row.key}`}>Ends (optional)</label>
                <input
                  id={`ev-end-${row.key}`}
                  type="datetime-local"
                  value={row.end}
                  min={row.start || undefined}
                  onChange={(e) => setRow(row.key, { end: e.target.value })}
                />
              </div>
              <button
                type="button"
                className="btn ghost sm"
                disabled={times.length === 1}
                aria-label={`Remove time ${i + 1}`}
                onClick={() => setTimes((rows) => rows.filter((r) => r.key !== row.key))}
              >
                Remove
              </button>
            </div>
          ))}
          <div className="row">
            <button
              type="button"
              className="btn ghost sm"
              disabled={times.length >= MAX_TIMES}
              onClick={() => setTimes((rows) => [...rows, newRow()])}
            >
              Add another time
            </button>
          </div>
          <p className="note" role="status">
            {filled.length <= 1
              ? "One time: this is a set event. Invitees RSVP."
              : `${filled.length} times: invitees tick every time that works, then you lock one.`}
          </p>
          {event && event.status !== "poll" && filled.length > 1 ? (
            <p className="hint">If the locked time is still in the list, the event stays set at that time.</p>
          ) : null}
        </fieldset>

        {error ? (
          <p className="err" role="alert">
            {error}
          </p>
        ) : null}
        <div className="row">
          <button className="btn" type="submit" disabled={save.isPending}>
            {save.isPending ? "Saving…" : event ? "Save event" : filled.length > 1 ? "Send the times" : "Create event"}
          </button>
          <button className="btn ghost" type="button" onClick={onDone}>
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}
