/**
 * Admin settings: desk emails, support address, athlete auto-enable,
 * welcome email, and the two switches that let notifications out of the
 * portal (activity emails, web push). Both stay off while testing.
 */
import { DESK_LABELS, Desk as DeskEnum, type Desk, PortalSettings } from "@niltv/types";
import { useIsFetching, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useState } from "react";
import { api, errorText } from "../../api";
import { describeIssues, splitEmails } from "../../lib/format";
import { qk } from "../../queries";
import { ErrorNote, Loading, Switch } from "../../ui/bits";
import { useMe } from "../../ui/me";
import { useToast } from "../../ui/Toast";

const looksLikeEmail = (s: string): boolean => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);

export function SettingsForm() {
  const qc = useQueryClient();
  const toast = useToast();
  const { notifications } = useMe();
  const settings = useQuery({ queryKey: qk.settings, queryFn: api.settings });
  const meFetching = useIsFetching({ queryKey: qk.me }) > 0;
  const [deskEmails, setDeskEmails] = useState<Record<Desk, string>>({ content: "", support: "", payments: "" });
  const [supportEmail, setSupportEmail] = useState("");
  const [autoEnable, setAutoEnable] = useState(false);
  const [welcome, setWelcome] = useState(false);
  const [activityEmails, setActivityEmails] = useState(false);
  const [webPush, setWebPush] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!settings.data || loaded) return;
    const s = settings.data;
    setDeskEmails({
      content: (s.deskEmails.content ?? []).join(", "),
      support: (s.deskEmails.support ?? []).join(", "),
      payments: (s.deskEmails.payments ?? []).join(", "),
    });
    setSupportEmail(s.supportEmail);
    setAutoEnable(s.autoEnableAthletes);
    setWelcome(s.welcomeEmail);
    setActivityEmails(s.activityEmails);
    setWebPush(s.webPush);
    setLoaded(true);
  }, [settings.data, loaded]);

  const save = useMutation({
    mutationFn: (input: ReturnType<typeof PortalSettings.parse>) => api.saveSettings(input),
    onSuccess: (saved) => {
      qc.setQueryData(qk.settings, saved);
      // GET /v1/me carries the switches (and the push key) to every screen.
      void qc.invalidateQueries({ queryKey: qk.me });
      toast("Settings saved.");
    },
    onError: (err) => setError(errorText(err)),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const lists: Partial<Record<Desk, string[]>> = {};
    for (const d of DeskEnum.options) {
      const list = splitEmails(deskEmails[d]);
      const bad = list.find((x) => !looksLikeEmail(x));
      if (bad) return setError(`${DESK_LABELS[d]}: "${bad}" is not an email address.`);
      if (list.length) lists[d] = list;
    }
    if (!looksLikeEmail(supportEmail.trim())) return setError("The support email is not an email address.");
    const parsed = PortalSettings.safeParse({
      deskEmails: lists,
      supportEmail: supportEmail.trim().toLowerCase(),
      autoEnableAthletes: autoEnable,
      welcomeEmail: welcome,
      activityEmails,
      webPush,
    });
    if (!parsed.success) return setError(describeIssues(parsed.error.issues));
    save.mutate(parsed.data);
  };

  // Push saved on, but this stage has no VAPID key: nobody can turn it on yet.
  const pushKeysMissing = settings.data?.webPush === true && !notifications.vapidPublicKey && !meFetching;

  if (settings.isPending) return <Loading what="Loading settings" />;
  if (settings.error) return <ErrorNote error={settings.error} onRetry={() => void settings.refetch()} />;

  return (
    <div className="panel">
      <form onSubmit={submit} noValidate aria-labelledby="settings-h">
        <h3 id="settings-h">Settings</h3>
        <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="lbl">Desk emails</legend>
          <p className="hint">Who gets an email when a message lands in each desk, on top of staff who picked that desk. Separate addresses with commas.</p>
          {DeskEnum.options.map((d) => (
            <div className="field" key={d}>
              <label htmlFor={`set-desk-${d}`}>{DESK_LABELS[d]}</label>
              <textarea
                id={`set-desk-${d}`}
                className="fit"
                rows={1}
                value={deskEmails[d]}
                placeholder="name@niltv.com"
                onChange={(e) => setDeskEmails((cur) => ({ ...cur, [d]: e.target.value }))}
              />
            </div>
          ))}
        </fieldset>
        <div className="field">
          <label htmlFor="set-support">Support email</label>
          <input id="set-support" type="email" value={supportEmail} onChange={(e) => setSupportEmail(e.target.value)} />
          <span className="hint">Where the Help form goes.</span>
        </div>
        <Switch
          checked={autoEnable}
          onChange={setAutoEnable}
          label="Turn on accounts for accepted athletes automatically"
          help="Leave this off until testing is done. While it is off, accepted athletes wait on the Athletes page until an admin enables them."
        />
        <Switch
          checked={welcome}
          onChange={setWelcome}
          label="Send welcome and invite emails"
          help="A welcome when someone gets access, and one invite to each accepted athlete with no account yet."
        />
        <Switch
          checked={activityEmails}
          onChange={setActivityEmails}
          label="Activity emails"
          help="Summary emails for unseen activity, desk alerts for staff, important announcements and last-minute schedule changes. Help, page change requests and approval interest always email staff."
        />
        <Switch
          checked={webPush}
          onChange={setWebPush}
          label="Phone and browser notifications"
          help="Web push for people who turn it on in Account."
        />
        {pushKeysMissing ? (
          <p className="warnmsg" role="status">
            Push keys are not set up for this stage yet. Run <code>backend/scripts/portal-vapid.ts</code> first.
          </p>
        ) : null}
        {error ? (
          <p className="err" role="alert">
            {error}
          </p>
        ) : null}
        <div className="row">
          <button className="btn" type="submit" disabled={save.isPending}>
            {save.isPending ? "Saving…" : "Save settings"}
          </button>
        </div>
      </form>
    </div>
  );
}
