/**
 * Account (Profile for guests): name, time zone, notifications, and for
 * staff the desks they answer. Campus and sport are staff-set.
 *
 * Notifications: one cadence per topic (Right away, Daily summary, Off),
 * and while web push is on, message previews plus this device and the
 * list of devices that get notifications.
 */
import {
  DESK_LABELS,
  Desk as DeskEnum,
  type Desk,
  NOTIFY_TOPIC_CADENCES,
  type NotifyCadence,
  type NotifyPrefs,
  type NotifyPrefsUpdate,
  NotifyTopic as NotifyTopicEnum,
  PortalMeUpdate,
  type PortalMeResponse,
  desksFor,
  isStaffRole,
} from "@niltv/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, type ReactNode, useMemo, useState } from "react";
import { api, errorText } from "../api";
import { CADENCE_LABELS, campusName, describeIssues, notifyTopicsFor, ROLE_LABELS, schoolLabel } from "../lib/format";
import { thisDeviceId } from "../lib/push";
import { browserZone, formatShortDate, listTimeZones, zoneAbbr } from "../lib/time";
import { qk, useOpenDesk } from "../queries";
import { Check, ErrorNote, Loading, PageHead, Switch } from "../ui/bits";
import { useMe } from "../ui/me";
import { useToast } from "../ui/Toast";
import { usePush } from "../ui/usePush";

const NOTIFY_KEYS = [...NotifyTopicEnum.options, "previews"] as const satisfies readonly (keyof NotifyPrefs)[];

export function Account() {
  const { member, notifications, signOut } = useMe();
  const qc = useQueryClient();
  const toast = useToast();
  const openDesk = useOpenDesk();
  const staff = isStaffRole(member.role);
  const guest = member.role === "guest";
  const myDesks = desksFor(member.role);

  const browser = browserZone();
  const [name, setName] = useState(member.name);
  const [timezone, setTimezone] = useState(member.timezone ?? browser);
  const [notify, setNotify] = useState<NotifyPrefs>(member.notify);
  const [desks, setDesks] = useState<Set<Desk>>(new Set(member.desks));
  const [error, setError] = useState<string | null>(null);

  const zones = useMemo(() => {
    const list = listTimeZones();
    return list.includes(timezone) ? list : [timezone, ...list];
  }, [timezone]);

  const save = useMutation({
    mutationFn: (input: ReturnType<typeof PortalMeUpdate.parse>) => api.updateMe(input),
    onSuccess: (res) => {
      // PATCH returns unreadMessages 0; keep the badge from the last GET.
      qc.setQueryData<PortalMeResponse>(qk.me, (old) => (old ? { ...old, member: res.member } : res));
      toast("Saved.");
    },
    onError: (err) => setError(errorText(err)),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!name.trim()) return setError("Your name cannot be empty.");
    // Send only what changed: a sent name counts as hand-edited, and the
    // onboarding sync stops updating it.
    const nextDesks = [...desks].filter((d) => myDesks.includes(d));
    const desksChanged =
      staff && (nextDesks.length !== member.desks.length || nextDesks.some((d) => !member.desks.includes(d)));
    const notifyChanged: NotifyPrefsUpdate = Object.fromEntries(
      NOTIFY_KEYS.filter((k) => notify[k] !== member.notify[k]).map((k) => [k, notify[k]]),
    );
    const parsed = PortalMeUpdate.safeParse({
      ...(name.trim() !== member.name ? { name: name.trim() } : {}),
      ...(timezone !== member.timezone ? { timezone } : {}),
      ...(Object.keys(notifyChanged).length ? { notify: notifyChanged } : {}),
      ...(desksChanged ? { desks: nextDesks } : {}),
    });
    if (!parsed.success) return setError(describeIssues(parsed.error.issues));
    if (Object.keys(parsed.data).length === 0) return toast("Nothing to save.");
    save.mutate(parsed.data);
  };

  return (
    <>
      <PageHead
        title={guest ? "Profile" : "Account"}
        sub={staff ? undefined : "Your details, your time zone and what reaches you from the portal."}
        access={staff ? "You and admins" : "You and staff"}
      />
      <form onSubmit={submit} style={{ gap: 20 }} aria-label={guest ? "Profile" : "Account"}>
        <section className="panel two" aria-labelledby="acct-profile-h">
          <h3 id="acct-profile-h" className="full">
            Profile
          </h3>
          <div className="field">
            <label htmlFor="ac-name">Name</label>
            <input id="ac-name" value={name} maxLength={80} required autoComplete="name" onChange={(e) => setName(e.target.value)} />
            <span className="hint">Shown in messages and to staff.</span>
          </div>
          <div className="field">
            <span className="lbl">Email</span>
            <div className="readbox">{member.email}</div>
            <span className="hint">Your niltv.com sign-in. Change it on niltv.com.</span>
          </div>
          {member.role === "athlete" ? (
            <div className="field">
              <span className="lbl">Campus, sport and school</span>
              <div className="readbox">
                {[campusName(member.campus), member.sport, schoolLabel(member.school)].filter(Boolean).join(" · ") ||
                  "Not set yet"}
              </div>
              <span className="row">
                <span className="hint">Set by staff from your signup.</span>
                <button
                  type="button"
                  className="linkbtn"
                  disabled={openDesk.isPending}
                  onClick={() => openDesk.mutate({ desk: "support" })}
                >
                  Ask Athlete support to change these
                </button>
              </span>
              {openDesk.error ? <span className="err">{errorText(openDesk.error)}</span> : null}
            </div>
          ) : null}
          {guest ? (
            <div className="field">
              <span className="lbl">What you are helping with</span>
              <div className="readbox">{member.note || "Not set yet"}</div>
              <span className="hint">Set by staff.</span>
            </div>
          ) : null}
          {staff ? (
            <div className="field">
              <span className="lbl">Role</span>
              <div className="readbox">{ROLE_LABELS[member.role]}</div>
              <span className="hint">Changed by an admin.</span>
            </div>
          ) : null}
          <div className="field">
            <label htmlFor="ac-tz">Time zone</label>
            <select id="ac-tz" value={timezone} onChange={(e) => setTimezone(e.target.value)}>
              {zones.map((z) => (
                <option key={z} value={z}>
                  {z.replace(/_/g, " ")}
                </option>
              ))}
            </select>
            <span className="hint">
              Every time in the portal shows in this zone ({zoneAbbr(new Date(), timezone)}). This device is on{" "}
              {browser.replace(/_/g, " ")}.
            </span>
          </div>
        </section>

        <section className="panel stack" aria-labelledby="acct-notify-h">
          <h3 id="acct-notify-h">Notifications</h3>
          <OffNote activityEmails={notifications.activityEmails} webPush={notifications.webPush} />
          <p className="note">Everything new shows as a badge here. Choose what reaches you outside the portal.</p>
          <div className="cadences">
            {notifyTopicsFor(member.role).map(({ topic, label, help }) => {
              const allowed = NOTIFY_TOPIC_CADENCES[topic];
              // A cadence the topic no longer offers shows as the nearest one it does.
              const value = allowed.includes(notify[topic]) ? notify[topic] : (allowed[0] ?? "off");
              return (
                <div className="cadence" key={topic}>
                  <div className="txt">
                    <label htmlFor={`ac-n-${topic}`}>{label}</label>
                    <span id={`ac-n-${topic}-help`} className="hint">
                      {help}
                    </span>
                  </div>
                  <select
                    id={`ac-n-${topic}`}
                    value={value}
                    aria-describedby={`ac-n-${topic}-help`}
                    onChange={(e) => setNotify((cur) => ({ ...cur, [topic]: e.target.value as NotifyCadence }))}
                  >
                    {allowed.map((c) => (
                      <option key={c} value={c}>
                        {CADENCE_LABELS[c]}
                      </option>
                    ))}
                  </select>
                </div>
              );
            })}
          </div>
          <p className="hint">
            Right away sends a phone or browser notification. Anything still unread an hour later goes in one summary
            email. Summary emails never arrive between 10 PM and 8 AM in your time zone.
          </p>
          {notifications.webPush ? (
            <>
              <Switch
                checked={notify.previews}
                onChange={(on) => setNotify((cur) => ({ ...cur, previews: on }))}
                label="Show message text in notifications"
                help={'Off shows only who wrote, like "New message from Athlete support".'}
              />
              {notifications.vapidPublicKey ? (
                <Devices />
              ) : (
                <p className="hint">Phone and browser notifications are not set up yet.</p>
              )}
            </>
          ) : null}
        </section>

        {staff ? (
          <section className="panel stack" aria-labelledby="acct-desks-h">
            <h3 id="acct-desks-h">Desks you answer</h3>
            <p className="note">New messages in these desks reach you as Desk messages under Notifications.</p>
            <div className="desks">
              {DeskEnum.options.map((d) => {
                const allowed = myDesks.includes(d);
                return (
                  <Check
                    key={d}
                    checked={desks.has(d)}
                    disabled={!allowed}
                    onChange={(on) =>
                      setDesks((cur) => {
                        const next = new Set(cur);
                        if (on) next.add(d);
                        else next.delete(d);
                        return next;
                      })
                    }
                  >
                    {DESK_LABELS[d]}
                  </Check>
                );
              })}
            </div>
            {!myDesks.includes("payments") ? <span className="hint">The Payments desk is admin only.</span> : null}
          </section>
        ) : null}

        {error ? (
          <p className="err" role="alert">
            {error}
          </p>
        ) : null}
        <div className="row">
          <button className="btn" type="submit" disabled={save.isPending}>
            {save.isPending ? "Saving…" : "Save changes"}
          </button>
          <button type="button" className="btn ghost" onClick={signOut}>
            Sign out
          </button>
        </div>
      </form>
    </>
  );
}

/** Which outside channels are still off while the portal is in testing. */
function OffNote({ activityEmails, webPush }: { activityEmails: boolean; webPush: boolean }) {
  const saved = "Your choices are saved for when they turn on.";
  let text: string | undefined;
  if (!activityEmails && !webPush) text = `Notifications are off while the portal is in testing. ${saved}`;
  else if (!activityEmails) text = `Summary emails are off while the portal is in testing. ${saved}`;
  else if (!webPush) text = `Phone and browser notifications are off while the portal is in testing. ${saved}`;
  return text ? <p className="notice">{text}</p> : null;
}

/** This browser and every device that gets this account's notifications. These act at once, not on Save. */
function Devices() {
  const { zone } = useMe();
  const toast = useToast();
  const push = usePush();
  const devices = useQuery({ queryKey: qk.pushDevices, queryFn: api.pushDevices, select: (r) => r.devices });
  const remove = useMutation({
    mutationFn: (id: string) => push.removeDevice(id),
    onSuccess: () => toast("Removed. That device gets no more notifications."),
    onError: (err) => toast(errorText(err), "bad"),
  });
  const mine = thisDeviceId();

  const turnOn = () => {
    push
      .turnOn()
      .then((result) => {
        if (result === "on") toast("Notifications are on for this browser.");
      })
      .catch((err: unknown) => toast(errorText(err), "bad"));
  };
  const turnOff = () => {
    void push.turnOff().then(() => toast("Notifications are off for this browser."));
  };

  let here: ReactNode;
  if (push.support === "ios-home-screen") {
    here = (
      <p className="note">
        On iPhone, add the portal to your Home Screen first: tap Share, then Add to Home Screen. Open it from there and
        turn notifications on.
      </p>
    );
  } else if (push.support === "unsupported") {
    here = <p className="note">This browser cannot show notifications.</p>;
  } else if (push.permission === "denied") {
    here = <p className="note">Notifications are blocked for this site. Allow them in your browser settings, then come back.</p>;
  } else if (push.subscribed === undefined) {
    here = <Loading what="Checking this browser" />;
  } else if (push.subscribed && push.permission === "granted") {
    here = (
      <div className="row">
        <span className="note">Notifications are on for this browser.</span>
        <button type="button" className="btn ghost sm" disabled={push.busy} onClick={turnOff}>
          Turn off
        </button>
      </div>
    );
  } else {
    here = (
      <div className="row">
        <button type="button" className="btn sm" disabled={push.busy} onClick={turnOn}>
          {push.busy ? "Turning on…" : "Turn on notifications"}
        </button>
      </div>
    );
  }

  return (
    <>
      <div className="field">
        <span className="lbl">This device</span>
        {here}
      </div>
      <div className="field">
        <span className="lbl" id="acct-devices-h">
          Your devices
        </span>
        {devices.isPending ? <Loading what="Loading devices" /> : null}
        <ErrorNote error={devices.error} onRetry={() => void devices.refetch()} />
        {devices.data?.length === 0 ? <span className="hint">No devices get notifications yet.</span> : null}
        {devices.data?.length ? (
          <ul className="devices" aria-labelledby="acct-devices-h">
            {devices.data.map((d) => (
              <li key={d.id}>
                <span>
                  <span className="t">{d.label}</span>
                  {d.id === mine ? <span className="muted"> (this browser)</span> : null}
                  <br />
                  <span className="meta">Added {formatShortDate(d.createdAt, zone)}</span>
                </span>
                <button
                  type="button"
                  className="btn ghost sm"
                  disabled={remove.isPending}
                  aria-label={`Remove ${d.label}`}
                  onClick={() => remove.mutate(d.id)}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </>
  );
}
