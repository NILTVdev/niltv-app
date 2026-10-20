/** Help: a topic and a message to the support inbox; replies come by email. */
import { HelpRequest, type HelpTopic } from "@niltv/types";
import { useMutation } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { api, errorText } from "../api";
import { describeIssues, HELP_TOPICS } from "../lib/format";
import { PageHead } from "../ui/bits";
import { useMe } from "../ui/me";

export function Help() {
  const { member } = useMe();
  const [topic, setTopic] = useState<HelpTopic>("other");
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  const send = useMutation({
    mutationFn: (input: ReturnType<typeof HelpRequest.parse>) => api.help(input),
    onSuccess: () => {
      setSent(true);
      setMessage("");
    },
    onError: (err) => setError(errorText(err)),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setSent(false);
    if (message.trim().length < 5) return setError("Tell us a little more (a few words at least).");
    const parsed = HelpRequest.safeParse({ topic, message: message.trim() });
    if (!parsed.success) return setError(describeIssues(parsed.error.issues));
    send.mutate(parsed.data);
  };

  return (
    <>
      <PageHead title="Help" sub="Something not working, or a question the team has not answered? Send it here." />
      <div className="panel" style={{ maxWidth: 640 }}>
        <form onSubmit={submit} noValidate aria-label="Help request">
          <div className="field">
            <label htmlFor="hp-topic">What is it about?</label>
            <select id="hp-topic" value={topic} onChange={(e) => setTopic(e.target.value as HelpTopic)}>
              {Object.entries(HELP_TOPICS).map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="hp-msg">Message</label>
            <textarea
              id="hp-msg"
              rows={6}
              maxLength={5000}
              required
              value={message}
              placeholder="What happened, and what you expected to happen"
              onChange={(e) => setMessage(e.target.value)}
            />
          </div>
          {error ? (
            <p className="err" role="alert">
              {error}
            </p>
          ) : null}
          {sent ? (
            <p className="okmsg" role="status">
              Sent. We reply by email to {member.email}.
            </p>
          ) : null}
          <div className="row">
            <button className="btn" type="submit" disabled={send.isPending}>
              {send.isPending ? "Sending…" : "Send"}
            </button>
          </div>
        </form>
      </div>
    </>
  );
}
