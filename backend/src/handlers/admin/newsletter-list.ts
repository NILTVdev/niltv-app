/**
 * GET /admin/newsletter (staff) — subscriber export off the SUBS#ALL GSI
 * partition, oldest-first (design §6.7: staff exports from the table until a
 * send provider exists). Default JSON; `?format=csv` returns text/csv ready
 * for a spreadsheet or a provider import.
 */
import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { AdminSubscriberListResponse, Subscriber } from "@niltv/types";
import type { APIGatewayProxyHandlerV2WithJWTAuthorizer } from "aws-lambda";
import { GSI1, SUBS_ALL_GSI1PK, getDocClient } from "../../lib/db";
import { forbidden, json } from "../../lib/http";
import type { Item } from "../../lib/shape";
import { requireStaff } from "./authz";

/**
 * RFC-4180-enough quoting: wrap fields containing separators/quotes/newlines.
 * Also neutralizes spreadsheet formula injection: a
 * public signup could set phone to `=WEBSERVICE(...)` or `+cmd|...` and it
 * would execute when staff open this export in Excel or Sheets. Any field
 * starting with a formula trigger is prefixed with an apostrophe (the OWASP
 * mitigation; spreadsheets render it as plain text) and force-quoted.
 */
const csvField = (value: string): string => {
  const neutralized = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return neutralized !== value || /[",\n\r]/.test(neutralized)
    ? `"${neutralized.replaceAll('"', '""')}"`
    : neutralized;
};

export function subscribersToCsv(subscribers: Subscriber[]): string {
  const lines = ["email,phone,sources,createdAt,confirmed"];
  for (const sub of subscribers) {
    lines.push(
      [
        csvField(sub.email),
        csvField(sub.phone ?? ""),
        csvField([...new Set(sub.sources)].join("|")),
        csvField(sub.createdAt),
        sub.confirmed ? "yes" : "no",
      ].join(","),
    );
  }
  return `${lines.join("\r\n")}\r\n`;
}

export const handler: APIGatewayProxyHandlerV2WithJWTAuthorizer = async (event) => {
  if (!requireStaff(event)) return forbidden();

  const db = getDocClient();
  const table = process.env.TABLE_NAME ?? "";

  const rows: Item[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await db.send(
      new QueryCommand({
        TableName: table,
        IndexName: GSI1,
        KeyConditionExpression: "GSI1PK = :pk",
        ExpressionAttributeValues: { ":pk": SUBS_ALL_GSI1PK },
        ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      }),
    );
    rows.push(...((page.Items ?? []) as Item[]));
    exclusiveStartKey = page.LastEvaluatedKey;
  } while (exclusiveStartKey);

  const items = rows.map((row) => Subscriber.parse(row));

  if (event.queryStringParameters?.["format"] === "csv") {
    return {
      statusCode: 200,
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": 'attachment; filename="niltv-newsletter.csv"',
      },
      body: subscribersToCsv(items),
    };
  }

  return json(200, AdminSubscriberListResponse.parse({ items }));
};
