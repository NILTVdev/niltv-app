/**
 * GET /admin/events/{id} (staff) — event + raw entry rows for the admin
 * events page (the public detail resolves athlete profiles and rotates the
 * order; admins want the stored rows with live counters as-is).
 */
import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { AdminEventDetailResponse } from "@niltv/types";
import type { APIGatewayProxyHandlerV2WithJWTAuthorizer } from "aws-lambda";
import { ENTRY_SK_PREFIX, eventKey, getDocClient } from "../../lib/db";
import { forbidden, json, notFound } from "../../lib/http";
import { requireStaff } from "./authz";

export const handler: APIGatewayProxyHandlerV2WithJWTAuthorizer = async (event) => {
  if (!requireStaff(event)) return forbidden();

  const eventId = event.pathParameters?.["id"];
  if (!eventId) return notFound();

  const db = getDocClient();
  const table = process.env.TABLE_NAME ?? "";

  const [metaOut, entriesOut] = await Promise.all([
    db.send(new GetCommand({ TableName: table, Key: eventKey(eventId) })),
    db.send(
      new QueryCommand({
        TableName: table,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :entry)",
        ExpressionAttributeValues: { ":pk": eventKey(eventId).PK, ":entry": ENTRY_SK_PREFIX },
      }),
    ),
  ]);

  if (!metaOut.Item) return notFound();
  return json(
    200,
    AdminEventDetailResponse.parse({ event: metaOut.Item, entries: entriesOut.Items ?? [] }),
  );
};
