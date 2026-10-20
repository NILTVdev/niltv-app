/**
 * Portal email: the platform's shared "Marquee" shell (lib/email-shell.ts),
 * sent through SES from the portal address.
 *
 * Message notices never carry the message text. Email leaves our systems
 * and gets forwarded; the portal is where the conversation lives. Everything
 * dynamic is HTML-escaped before it reaches the shell.
 */
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { buttonBlock, emailShell } from "../email-shell";

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
  const button = email.button ? buttonBlock(escapeHtml(email.button.label), portalUrl(email.button.path)) : "";
  const tail = email.tail ?? "You get this because you have a NIL TV Portal account. Change which emails you get in Account.";
  const html = emailShell({
    logoBase: process.env.EMAIL_LOGO_BASE,
    title: escapeHtml(email.subject),
    heading: escapeHtml(email.heading.toUpperCase()),
    lead: escapeHtml(email.lead),
    body: paragraphs + (button || '<tr><td style="padding:0 0 34px 0;"></td></tr>'),
    tail: escapeHtml(tail),
  });
  const text = [
    email.lead,
    ...(email.paragraphs ?? []),
    ...(email.button ? [`${email.button.label}: ${portalUrl(email.button.path)}`] : []),
    "",
    tail,
    "",
    "NIL TV",
  ].join("\n\n");
  return { html, text };
}

export async function sendEmail(to: string, email: PortalEmail, replyTo?: string): Promise<boolean> {
  const from = process.env.FROM_EMAIL ?? "portal@niltv.com";
  const { html, text } = renderEmail(email);
  try {
    await getSes().send(
      new SendEmailCommand({
        FromEmailAddress: `NIL TV Portal <${from}>`,
        Destination: { ToAddresses: [to] },
        ...(replyTo ? { ReplyToAddresses: [replyTo] } : {}),
        Content: {
          Simple: {
            Subject: { Data: email.subject },
            Body: { Text: { Data: text }, Html: { Data: html } },
          },
        },
      }),
    );
    return true;
  } catch (err) {
    console.error("portal: email failed", { subject: email.subject }, err);
    return false;
  }
}

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
