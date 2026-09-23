/**
 * The transactional email shell, the "Marquee" layout.
 *
 * One shell for every message the platform sends (Cognito verification and
 * staff invitation via `lib/email-templates.ts`, the newsletter confirm via
 * `handlers/newsletter.ts`) so they cannot drift apart again. Runtime-safe:
 * no CDK imports, so a Lambda bundle can carry it.
 *
 * The look: neutral black ground (the site's greys carry a blue bias that
 * reads blue-grey against a white inbox, so the email palette is neutral),
 * no card and no inset box, a short gold bar, condensed display type for the
 * heading and the numerals, Inter for body — the website's own pairing.
 *
 * Mail-client rules baked in:
 * - Table layout with inline styles, the only layout mail clients agree on.
 * - Explicit background AND text colour on every element, so a client that
 *   force-inverts for dark mode cannot strand text on its own colour.
 * - Web fonts load from Google Fonts where the client allows it (Apple Mail,
 *   iOS Mail); Gmail and Outlook fall back to Arial Narrow / Arial, and the
 *   sizes and tracking are chosen so the fallback still reads.
 * - The mark is a remote image with `alt` text; every other element,
 *   including a code, is live text. Without images the message still reads.
 * - The code is sized so six digits fit a 320px phone column in the fallback
 *   face (6 × (38 + 8) = 276px) and never wrap.
 */

export const EMAIL_GROUND = "#0a0a0a";
export const EMAIL_TEXT = "#f5f5f7";
export const EMAIL_LEAD = "#b3b3b3";
export const EMAIL_KICKER = "#a3a3a3";
export const EMAIL_FAINT = "#8f8f8f";
export const EMAIL_LINE = "#262626";
export const EMAIL_GOLD = "#d9b25b";
export const EMAIL_INK = "#0c0c10";

export const EMAIL_DISPLAY_FONT = "'Barlow Condensed','Arial Narrow',Arial,sans-serif";
export const EMAIL_BODY_FONT =
  "'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
export const EMAIL_MONO_FONT = "'SF Mono',Menlo,Consolas,'Liberation Mono','Courier New',monospace";

const FONT_LINK =
  '<link href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@800&amp;family=Inter:wght@400;600;700&amp;display=swap" rel="stylesheet">';

/** The mark from our CDN, or the text wordmark when no CDN base is configured. */
export function brandmark(logoBase: string | undefined): string {
  if (!logoBase) {
    return `<div style="font-family:${EMAIL_DISPLAY_FONT};font-size:30px;line-height:30px;font-weight:800;letter-spacing:2px;color:${EMAIL_GOLD};">NIL TV</div>`;
  }
  return `<img src="${logoBase}/video/brand/email/niltv-email@2x.png" width="160" alt="NILTV" style="display:block;width:160px;height:auto;border:0;">`;
}

/** Small tracked label in gold — "YOUR CODE", "USERNAME". */
export function kicker(text: string, paddingTop = 0): string {
  return `<div style="font-family:${EMAIL_BODY_FONT};font-size:11px;font-weight:600;letter-spacing:2.6px;color:${EMAIL_GOLD};padding-top:${paddingTop}px;">${text}</div>`;
}

/** A 1px hairline that survives Outlook (explicit height, zero font size). */
export function hairline(marginTop = 0): string {
  return `<div style="height:1px;background:${EMAIL_LINE};line-height:1px;font-size:0;margin-top:${marginTop}px;">&nbsp;</div>`;
}

/**
 * The verification-code block: kicker + large condensed numerals. `code` is
 * the literal text to print — the Cognito placeholder `{####}` in a template.
 */
export function codeBlock(code: string, label = "YOUR CODE"): string {
  return `<tr><td style="padding:36px 0 22px 0;">
${kicker(label)}
<div style="font-family:${EMAIL_DISPLAY_FONT};font-size:68px;line-height:68px;font-weight:800;letter-spacing:8px;color:${EMAIL_GOLD};padding-top:6px;">${code}</div>
</td></tr>`;
}

/** A gold pill call-to-action. Outlook squares the corners; everything else rounds them. */
export function buttonBlock(label: string, href: string): string {
  return `<tr><td style="padding:30px 0 34px 0;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
<td bgcolor="${EMAIL_GOLD}" style="background:${EMAIL_GOLD};border-radius:999px;">
<a href="${href}" style="display:inline-block;font-family:${EMAIL_BODY_FONT};font-size:15px;line-height:20px;font-weight:700;color:${EMAIL_INK};text-decoration:none;padding:15px 30px;border-radius:999px;">${label}</a>
</td></tr></table>
</td></tr>`;
}

/** Labelled credential rows for the staff invitation. */
export function credentialsBlock(rows: ReadonlyArray<{ label: string; value: string; mono?: boolean }>): string {
  const inner = rows
    .map((row, i) => {
      const font = row.mono ? EMAIL_MONO_FONT : EMAIL_BODY_FONT;
      const colour = row.mono ? EMAIL_GOLD : EMAIL_TEXT;
      const size = row.mono ? "22px;line-height:28px;letter-spacing:1px" : "20px;line-height:26px";
      return (
        (i > 0 ? hairline(16) : "") +
        kicker(row.label, i > 0 ? 16 : 0) +
        `<div style="font-family:${font};font-size:${size};font-weight:600;color:${colour};padding-top:6px;">${row.value}</div>`
      );
    })
    .join("\n");
  return `<tr><td style="padding:32px 0 16px 0;">
${inner}
</td></tr>`;
}

export type EmailShellInput = {
  /** CDN origin the mark is served from; absent → text wordmark. */
  logoBase?: string;
  /** `<title>` of the document; clients show it nowhere prominent but readers use it. */
  title: string;
  /** Display heading — write it in capitals; the display face is set for caps. */
  heading: string;
  /** One or two sentences under the heading. */
  lead: string;
  /** Table rows (`<tr>…</tr>`) between the lead and the closing hairline. */
  body: string;
  /** Small closing line ("Expires in 24 hours…"). */
  tail: string;
};

/** The whole document. */
export function emailShell({ logoBase, title, heading, lead, body, tail }: EmailShellInput): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
${FONT_LINK}
</head>
<body style="margin:0;padding:0;background:${EMAIL_GROUND};" bgcolor="${EMAIL_GROUND}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${EMAIL_GROUND}" style="background:${EMAIL_GROUND};">
<tr><td align="center" style="padding:44px 20px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;">

<tr><td style="padding:0;">
${brandmark(logoBase)}
<div style="font-family:${EMAIL_BODY_FONT};font-size:11px;font-weight:600;letter-spacing:3px;color:${EMAIL_KICKER};padding-top:12px;">THE HOME OF NIL CONTENT</div>
</td></tr>

<tr><td style="padding:28px 0 0 0;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="48"><tr><td height="3" bgcolor="${EMAIL_GOLD}" style="height:3px;line-height:3px;font-size:0;background:${EMAIL_GOLD};">&nbsp;</td></tr></table>
</td></tr>

<tr><td style="padding:18px 0 0 0;">
<div style="font-family:${EMAIL_DISPLAY_FONT};font-size:42px;line-height:42px;font-weight:800;letter-spacing:0.5px;color:${EMAIL_TEXT};">${heading}</div>
<div style="font-family:${EMAIL_BODY_FONT};font-size:15px;line-height:24px;color:${EMAIL_LEAD};padding-top:12px;">${lead}</div>
</td></tr>

${body}

<tr><td style="padding:0;">
${hairline()}
<div style="font-family:${EMAIL_BODY_FONT};font-size:13px;line-height:20px;color:${EMAIL_FAINT};padding-top:14px;">${tail}</div>
</td></tr>

<tr><td style="padding:44px 0 0 0;">
${hairline()}
<div style="font-family:${EMAIL_BODY_FONT};font-size:12px;line-height:19px;color:${EMAIL_FAINT};padding-top:16px;">NILTV &middot; <a href="https://niltv.com" style="color:${EMAIL_GOLD};text-decoration:none;">niltv.com</a></div>
</td></tr>

</table>
</td></tr></table>
</body>
</html>`;
}
