/**
 * Account (Profile for guests): name, time zone, email notifications, and
 * for staff the desks they answer. Campus and sport are staff-set.
 */
import {
  DESK_LABELS,
  Desk as DeskEnum,
  type Desk,
  type NotifyPrefs,
  PortalMeUpdate,
  type PortalMeResponse,
  desksFor,
  isStaffRole,
} from "@niltv/types";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useMemo, useState } from "react";
import { api, errorText } from "../api";
import { campusName, describeIssues, NOTIFY_LABELS, ROLE_LABELS, schoolLabel } from "../lib/format";
import { browserZone, listTimeZones, zoneAbbr } from "../lib/time";
import { qk, useOpenDesk } from "../queries";
import { Check, PageHead, Switch } from "../ui/bits";
import { useMe } from "../ui/me";
import { useToast } from "../ui/Toast";

const NOTIFY_KEYS = Object.keys(NOTIFY_LABELS) as (keyof NotifyPrefs)[];

export function Account() {
  const { member, signOut } = useMe();
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
    const notifyChanged = NOTIFY_KEYS.some((k) => notify[k] !== member.notify[k]);
    const parsed = PortalMeUpdate.safeParse({
      ...(name.trim() !== member.name ? { name: name.trim() } : {}),
      ...(timezone !== member.timezone ? { timezone } : {}),
      ...(notifyChanged ? { notify } : {}),
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
        sub={
          staff
            ? "Your staff profile, your email settings and the desks you answer."
            : "Your details, your time zone and the email you get from the portal."
        }
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
          </div>
          <div className="field">
            <label htmlFor="ac-email">Email</label>
            <input id="ac-email" value={member.email} readOnly aria-describedby="ac-email-help" />
            <span id="ac-email-help" className="hint">
              Your niltv.com sign-in. Change it on niltv.com.
            </span>
          </div>
          {member.role === "athlete" ? (
            <div className="field full">
              <span className="lbl">Campus, sport and school</span>
              <span>
                {[campusName(member.campus), member.sport, schoolLabel(member.school)].filter(Boolean).join(" · ") ||
                  "Not set yet"}
              </span>
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
          {guest && member.note ? (
            <div className="field full">
              <span className="lbl">What you are helping with</span>
              <span>
                {member.note} <span className="muted">(set by staff)</span>
              </span>
            </div>
          ) : null}
          {staff ? (
            <div className="field">
              <span className="lbl">Role</span>
              <span>
                {ROLE_LABELS[member.role]} <span className="muted">(changed by an admin)</span>
              </span>
            </div>
          ) : null}
          <div className="field">
            <label htmlFor="ac-tz">Time zone</label>
            <select id="ac-tz" value={timezone} onChange={(e) => setTimezone(e.target.value)}>
              {zones.map((z) => (
                <option key={z} value={z}>
                  {z.replace(/_/g, " ")}
                  {z === browser ? " (this device)" : ""}
                </option>
              ))}
            </select>
            <span className="hint">Every time in the portal shows in this zone ({zoneAbbr(new Date(), timezone)}).</span>
          </div>
        </section>

        <section className="panel stack" aria-labelledby="acct-notify-h">
          <h3 id="acct-notify-h">Email notifications</h3>
          <p className="note">The portal emails {member.email}. Pick what is worth an email.</p>
          {NOTIFY_KEYS.filter((k) => !(guest && (k === "channelMessages" || k === "announcements" || k === "postings"))).map(
            (k) => (
              <Switch
                key={k}
                checked={notify[k]}
                onChange={(on) => setNotify((cur) => ({ ...cur, [k]: on }))}
                label={NOTIFY_LABELS[k].label}
                help={NOTIFY_LABELS[k].help}
              />
            ),
          )}
        </section>

        {staff ? (
          <section className="panel stack" aria-labelledby="acct-desks-h">
            <h3 id="acct-desks-h">Desks you answer</h3>
            <p className="note">You get an email when a new message lands in these desks.</p>
            <div className="row">
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
