/**
 * GET /v1/newsletter/confirm?token=… (public — the link in the confirm email)
 * — second half of the newsletter double opt-in. A valid
 * one-time token flips its subscriber to confirmed, retires the token, and only
 * then forwards the address to the send provider. Always answers with a
 * redirect to the site so the visitor lands on a page, never on raw JSON.
 */
import { DeleteCommand, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyHandlerV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { getDocClient, newsletterTokenKey, subscriberKey } from "../lib/db";
import { forbidden } from "../lib/http";
import { forwardToProvider } from "../lib/newsletter-provider";
import { requireOriginVerify } from "../lib/origin";

const TOKEN_RE = /^[a-f0-9]{48}$/;

const redirect = (outcome: "confirmed" | "invalid"): APIGatewayProxyStructuredResultV2 => ({
  statusCode: 302,
  headers: {
    location: `${process.env.SITE_ORIGIN ?? "https://niltv.com"}/?newsletter=${outcome}`,
    "cache-control": "no-store",
  },
  body: "",
});

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  if (!requireOriginVerify(event)) return forbidden();

  const token = event.queryStringParameters?.["token"] ?? "";
  if (!TOKEN_RE.test(token)) return redirect("invalid");

  const db = getDocClient();
  const table = process.env.TABLE_NAME ?? "";

  const tokenRow = (await db.send(new GetCommand({ TableName: table, Key: newsletterTokenKey(token) }))).Item as
    | { email?: string }
    | undefined;
  if (!tokenRow?.email) return redirect("invalid");
  const email = tokenRow.email;

  let updated: { sources?: string[] } | undefined;
  try {
    const res = await db.send(
      new UpdateCommand({
        TableName: table,
        Key: subscriberKey(email),
        UpdateExpression: "SET confirmed = :t, confirmedAt = :now REMOVE confirmToken, confirmSentAt",
        ConditionExpression: "attribute_exists(PK)",
        ExpressionAttributeValues: { ":t": true, ":now": new Date().toISOString() },
        ReturnValues: "ALL_NEW",
      }),
    );
    updated = res.Attributes as { sources?: string[] } | undefined;
  } catch (err) {
    if ((err as { name?: string }).name === "ConditionalCheckFailedException") return redirect("invalid");
    throw err;
  }
  await db.send(new DeleteCommand({ TableName: table, Key: newsletterTokenKey(token) }));

  await forwardToProvider(email, updated?.sources?.[0] ?? "home_band");
  return redirect("confirmed");
};
