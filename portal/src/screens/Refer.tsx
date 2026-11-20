/** Refer friends: a link to the athlete signup form, ready to copy. */
import { useRef, useState } from "react";
import { PageHead } from "../ui/bits";
import { useToast } from "../ui/Toast";

const SIGNUP_URL = "https://niltv.com/athlete-signup/";

export function Refer() {
  const toast = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(SIGNUP_URL);
      setCopied(true);
      toast("Link copied.");
    } catch {
      inputRef.current?.select();
      toast("Press Ctrl+C or Cmd+C to copy the selected link.");
    }
  };

  return (
    <>
      <PageHead title="Refer friends" sub="Know an athlete who should be on NIL TV? Send them this link." />
      <div className="panel stack" style={{ maxWidth: 640 }}>
        <div className="field">
          <label htmlFor="refer-link">Athlete signup link</label>
          <input id="refer-link" ref={inputRef} readOnly value={SIGNUP_URL} onFocus={(e) => e.target.select()} />
        </div>
        <div className="row">
          <button type="button" className="btn" onClick={() => void copy()}>
            {copied ? "Copied" : "Copy link"}
          </button>
          <a className="btn ghost" href={SIGNUP_URL} target="_blank" rel="noopener noreferrer">
            Open the form
          </a>
        </div>
        <p className="note">They fill in the form, sign the agreement, and the team takes it from there.</p>
      </div>
    </>
  );
}
