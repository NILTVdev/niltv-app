/**
 * POST /v1/newsletter (public — origin-verify + WAF/throttle gated, no JWT) —
 * design §6.7: DynamoDB is the system of record from day one so no signup is
 * ever lost. First signup writes the SUB row (+ SUBS#ALL export mirror) and a
 * one-time confirm token, then emails a confirm link; repeats append the new
 * entry-point source and backfill the phone.
 *
 * DOUBLE OPT-IN: a public, unauthenticated form must not
 * let anyone enroll an address they do not own. A subscriber is
 * `confirmed:false` until the emailed link is followed (newsletter-confirm.ts);
 * only confirmed addresses are forwarded to the send provider. Re-signups of an
 * unconfirmed address resend the link at most once per CONFIRM_RESEND_MIN_MS,
 * so the form cannot be used to bomb an inbox either.
 */
import { randomBytes } from "node:crypto";
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { AckResponse, NewsletterRequest } from "@niltv/types";
import type { APIGatewayProxyHandlerV2 } from "aws-lambda";
import { getDocClient, newsletterTokenKey, subscriberGsi, subscriberKey } from "../lib/db";
import { buttonBlock, emailShell } from "../lib/email-shell";
import { badRequest, forbidden, json, parseJsonBody } from "../lib/http";
import { requireOriginVerify } from "../lib/origin";

const CONFIRM_RESEND_MIN_MS = 10 * 60 * 1000;
const CONFIRM_SUBJECT = "Confirm your NILTV newsletter signup";

const isConditionalCheckFailed = (err: unknown): boolean =>
  typeof err === "object" && err !== null && (err as { name?: string }).name === "ConditionalCheckFailedException";

let ses: SESv2Client | undefined;
const getSes = (): SESv2Client => (ses ??= new SESv2Client({}));

const newToken = (): string => randomBytes(24).toString("hex");

/** Best-effort: a failed send is logged; the row and its token already exist, so a re-signup retries. */
async function sendConfirmEmail(email: string, token: string): Promise<boolean> {
  const apiOrigin = process.env.PUBLIC_API_ORIGIN;
  const from = process.env.FROM_EMAIL ?? "no-reply@niltv.com";
  if (!apiOrigin) {
    console.error("newsletter: PUBLIC_API_ORIGIN unset, confirm email skipped");
    return false;
  }
  const link = `${apiOrigin}/v1/newsletter/confirm?token=${token}`;
  const text =
    "Thanks for signing up for NILTV updates.\n\n" +
    `Confirm your email to start receiving them:\n${link}\n\n` +
    "If you did not sign up, ignore this message and nothing will be sent.\n\nNILTV";
  // Same shell as the Cognito mail (src/lib/email-shell.ts); the mark comes
  // from the stage's CDN via EMAIL_LOGO_BASE, text wordmark when unset.
  const html = emailShell({
    logoBase: process.env.EMAIL_LOGO_BASE,
    title: CONFIRM_SUBJECT,
    heading: "CONFIRM YOUR EMAIL",
    lead: "Thanks for signing up for NILTV updates. Confirm your email to start receiving them.",
    body: buttonBlock("Confirm my email", link),
    tail: "If you did not sign up, ignore this message and nothing will be sent.",
  });
  try {
    await getSes().send(
      new SendEmailCommand({
        FromEmailAddress: `NILTV <${from}>`,
        Destination: { ToAddresses: [email] },
        Content: {
          Simple: {
            Subject: { Data: CONFIRM_SUBJECT },
            Body: { Text: { Data: text }, Html: { Data: html } },
          },
        },
      }),
    );
    return true;
  } catch (err) {
    console.error("newsletter: confirm email failed", err);
    return false;
  }
}

type SubscriberRow = { confirmed?: boolean; confirmToken?: string; confirmSentAt?: string };

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  // Origin lockdown: only CloudFront (which injects x-origin-verify) may call.
  if (!requireOriginVerify(event)) return forbidden();

  const request = NewsletterRequest.safeParse(parseJsonBody(event.body, event.isBase64Encoded === true));
  if (!request.success) return badRequest();

  // email arrives normalized (trimmed/lowercased) by the contract schema.
  const { email, phone, source } = request.data;
  const db = getDocClient();
  const table = process.env.TABLE_NAME ?? "";
  const now = new Date().toISOString();

  const existing = (await db.send(new GetCommand({ TableName: table, Key: subscriberKey(email) }))).Item as
    | SubscriberRow
    | undefined;

  if (!existing) {
    const token = newToken();
    try {
      await db.send(
        new PutCommand({
          TableName: table,
          Item: {
            ...subscriberKey(email),
            ...subscriberGsi(now, email),
            email,
            ...(phone ? { phone } : {}),
            sources: [source],
            createdAt: now,
            confirmed: false,
            confirmToken: token,
            confirmSentAt: now,
          },
          ConditionExpression: "attribute_not_exists(PK)",
        }),
      );
      await db.send(
        new PutCommand({ TableName: table, Item: { ...newsletterTokenKey(token), email, createdAt: now } }),
      );
      await sendConfirmEmail(email, token);
      return json(200, AckResponse.parse({ status: "ok" }));
    } catch (err) {
      if (!isConditionalCheckFailed(err)) throw err;
      // Lost a race with a concurrent first signup: fall through to the
      // repeat path below against the row that won.
    }
  }

  // Repeat signup: append the (possibly new) source, backfill the phone,
  // keep createdAt and the export mirror where they are.
  await db.send(
    new UpdateCommand({
      TableName: table,
      Key: subscriberKey(email),
      UpdateExpression:
        "SET sources = list_append(if_not_exists(sources, :empty), :source), updatedAt = :now" +
        (phone ? ", phone = :phone" : ""),
      ExpressionAttributeValues: {
        ":empty": [],
        ":source": [source],
        ":now": now,
        ...(phone ? { ":phone": phone } : {}),
      },
    }),
  );

  // Unconfirmed repeat: resend the link, throttled. Reuse the standing token
  // so an earlier email still works; mint one only if the row predates
  // double opt-in.
  if (existing && !existing.confirmed) {
    const lastSent = existing.confirmSentAt ? Date.parse(existing.confirmSentAt) : 0;
    if (Date.now() - lastSent >= CONFIRM_RESEND_MIN_MS) {
      let token = existing.confirmToken;
      if (!token) {
        token = newToken();
        await db.send(
          new PutCommand({ TableName: table, Item: { ...newsletterTokenKey(token), email, createdAt: now } }),
        );
      }
      await db.send(
        new UpdateCommand({
          TableName: table,
          Key: subscriberKey(email),
          UpdateExpression: "SET confirmToken = :t, confirmSentAt = :now, confirmed = if_not_exists(confirmed, :f)",
          ExpressionAttributeValues: { ":t": token, ":now": now, ":f": false },
        }),
      );
      await sendConfirmEmail(email, token);
    }
  }

  return json(200, AckResponse.parse({ status: "ok" }));
};
