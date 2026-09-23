/**
 * Cognito message templates (design §6.2), built on the shared shell in
 * `src/lib/email-shell.ts`.
 *
 * The NILTV mark is served from our own CDN (`/video/brand/email/`, immutable)
 * and composed per stage, the same rule content media follows: no template is
 * welded to one stage's CloudFront domain. Without a CDN domain the shell falls
 * back to a text wordmark rather than a broken image.
 *
 * `{####}` is the placeholder Cognito substitutes; it must appear exactly once
 * per body. The invitation also carries `{username}`. Cognito caps a message
 * at 20,000 characters — `email-templates.test.ts` guards both rules.
 */

import { codeBlock, credentialsBlock, emailShell } from "../src/lib/email-shell";

export const VERIFICATION_EMAIL_SUBJECT = "Your NILTV verification code";

export function verificationEmailBody(logoBase?: string): string {
  return emailShell({
    logoBase,
    title: VERIFICATION_EMAIL_SUBJECT,
    heading: "VERIFY YOUR ACCOUNT",
    lead: "Enter this code in the app to finish creating your NILTV account.",
    body: codeBlock("{####}"),
    tail: "Expires in 24 hours. Ignore this if it wasn&rsquo;t you.",
  });
}

export const INVITE_EMAIL_SUBJECT = "Your NILTV staff account";

/** Admin-created (staff) accounts. Cognito substitutes {username} and {####}. */
export function inviteEmailBody(logoBase?: string): string {
  return emailShell({
    logoBase,
    title: INVITE_EMAIL_SUBJECT,
    heading: "YOUR STAFF ACCOUNT IS READY",
    lead: "Sign in to the NILTV admin tool with the username and temporary password below. You&rsquo;ll be asked to choose a new password.",
    body: credentialsBlock([
      { label: "USERNAME", value: "{username}" },
      { label: "TEMPORARY PASSWORD", value: "{####}", mono: true },
    ]),
    tail: "If you weren&rsquo;t expecting this, ignore it and the account stays locked.",
  });
}
