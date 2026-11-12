/**
 * Portal email: the platform's shared "Marquee" shell (lib/email-shell.ts),
 * sent through SES from the portal address.
 *
 * Message notices never carry the message text. Email leaves our systems
 * and gets forwarded; the portal is where the conversation lives. Everything
 * dynamic is HTML-escaped before it reaches the shell.
 */
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { buttonBlock, emailShell, PRIVACY_URL, TERMS_URL } from "../email-shell";

let ses: SESv2Client | undefined;
const getSes = (): SESv2Client => (ses ??= new SESv2Client({}));

export const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

export const portalUrl = (path = "/"): string => `${(process.env.PORTAL_URL ?? "https://portal.niltv.com").replace(/\/$/, "")}${path}`;

export interface PortalEmail {
  subject: string;
  heading: string;
  lead: string;
  /** optional paragraphs under the lead (plain text, escaped here) */
  paragraphs?: string[];
  /** a list under the paragraphs: one line each, an optional grey detail under it */
  rows?: { label: string; detail?: string }[];
  button?: { label: string; path: string };
  tail?: string;
}

const BODY_STYLE =
  "font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:24px;color:#b3b3b3;";

export function renderEmail(email: PortalEmail): { html: string; text: string } {
  const paragraphs = (email.paragraphs ?? [])
    .map(
      (p) =>
        `<tr><td style="padding:16px 0 0 0;"><div style="${BODY_STYLE}white-space:pre-wrap;">${escapeHtml(p)}</div></td></tr>`,
    )
    .join("");
  const rows = (email.rows ?? []).length
    ? `<tr><td style="padding:16px 0 0 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${(email.rows ?? [])
        .map(
          (row) =>
            `<tr><td style="padding:10px 0;border-bottom:1px solid #2a2a2a;"><div style="${BODY_STYLE}color:#ffffff;">${escapeHtml(row.label)}</div>${
              row.detail ? `<div style="${BODY_STYLE}font-size:13px;line-height:20px;">${escapeHtml(row.detail)}</div>` : ""
            }</td></tr>`,
        )
        .join("")}</table></td></tr>`
    : "";
  const button = email.button ? buttonBlock(escapeHtml(email.button.label), portalUrl(email.button.path)) : "";
  const tail = email.tail ?? "You get this because you have a NIL TV Portal account. Change which emails you get in Account.";
  const html = emailShell({
    logoBase: process.env.EMAIL_LOGO_BASE,
    title: escapeHtml(email.subject),
    heading: escapeHtml(email.heading.toUpperCase()),
    lead: escapeHtml(email.lead),
    body: paragraphs + rows + (button || '<tr><td style="padding:0 0 34px 0;"></td></tr>'),
    tail: escapeHtml(tail),
  });
  const text = [
    email.lead,
    ...(email.paragraphs ?? []),
    ...((email.rows ?? []).length
      ? [(email.rows ?? []).map((row) => `- ${row.label}${row.detail ? `\n  ${row.detail}` : ""}`).join("\n")]
      : []),
    ...(email.button ? [`${email.button.label}: ${portalUrl(email.button.path)}`] : []),
    "",
    tail,
    "",
    "NIL TV",
    `Privacy Policy: ${PRIVACY_URL}\nTerms of Use: ${TERMS_URL}`,
  ].join("\n\n");
  return { html, text };
}

/** Reserved test domains (RFC 2606): smoke-test accounts use them and must never cost a bounce. */
export const isTestAddress = (address: string): boolean => /\.(invalid|test|example)$/i.test(address.trim());

export async function sendEmail(to: string, email: PortalEmail, replyTo?: string): Promise<boolean> {
  if (isTestAddress(to)) {
    console.log("portal: skipped email to a test address", { subject: email.subject });
    return false;
  }
  const from = process.env.FROM_EMAIL ?? "portal@niltv.com";
  const { html, text } = renderEmail(email);
  const command = new SendEmailCommand({
    FromEmailAddress: `NIL TV Portal <${from}>`,
    Destination: { ToAddresses: [to] },
    ...(replyTo && !isTestAddress(replyTo) ? { ReplyToAddresses: [replyTo] } : {}),
    Content: {
      Simple: {
        // SES assumes 7-bit ASCII without a charset: accented names and curly
        // apostrophes would arrive garbled.
        Subject: { Data: email.subject, Charset: "UTF-8" },
        Body: { Text: { Data: text, Charset: "UTF-8" }, Html: { Data: html, Charset: "UTF-8" } },
      },
    },
  });
  for (let attempt = 0; ; attempt++) {
    try {
      await getSes().send(command);
      return true;
    } catch (err) {
      // An important announcement goes to every athlete at once: ride out the
      // account's per-second send rate instead of dropping people.
      if (isThrottle(err) && attempt < SEND_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt + Math.random() * 250));
        continue;
      }
      console.error("portal: email failed", { subject: email.subject }, err);
      return false;
    }
  }
}

const SEND_RETRIES = 4;

const isThrottle = (err: unknown): boolean => {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return (
    e.name === "TooManyRequestsException" ||
    e.name === "Throttling" ||
    e.name === "ThrottlingException" ||
    e.$metadata?.httpStatusCode === 429
  );
};

/** "Thu, Oct 23, 8:00 PM EDT" in the reader's zone (Eastern when unknown). */
export function formatWhen(iso: string, timeZone: string | undefined): string {
  const zone = timeZone && isValidZone(timeZone) ? timeZone : "America/New_York";
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: zone,
    timeZoneName: "short",
  }).format(new Date(iso));
}

function isValidZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}
