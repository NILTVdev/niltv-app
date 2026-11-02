/**
 * The NIL TV logo lockup. Brand rule: the logo is always the image from the
 * brand kit, never typed, never recolored or redrawn, at least 40px tall.
 * "PORTAL" is a label beside it, not part of the logo. The tagline lockup
 * is for openers (the sign-in screen); small uses get the logo alone.
 */
import { config } from "../config";

/** Brand kit 00_Logos/niltv-logo-gold-transparent.png, trimmed and sized for the web. */
const LOGO = "/brand/niltv-logo.webp";

export function Mark({ tagline = false }: { tagline?: boolean }) {
  return (
    <div className="mark">
      <img className="logo" src={LOGO} alt="NIL TV" width={573} height={192} />
      {tagline ? <p className="tagline">Real Name. Real Game. Real TV.</p> : null}
      <div className="sub">
        <small>Portal</small>
        {config.stage !== "prod" ? <span className="stage">{config.stage}</span> : null}
      </div>
    </div>
  );
}
