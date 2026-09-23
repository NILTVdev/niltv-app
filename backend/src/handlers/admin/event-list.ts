/**
 * GET /admin/events (staff) — every event, full entity shape (the public
 * events-list returns trimmed cards; admins see prize/partners/type too).
 * Same single GSI1 query and live → upcoming → ended ordering as the tab.
 */
import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { AdminEventListResponse } from "@niltv/types";
import type { APIGatewayProxyHandlerV2WithJWTAuthorizer } from "aws-lambda";
import { EVENTS_ALL_GSI1PK, GSI1, getDocClient } from "../../lib/db";
import { forbidden, json } from "../../lib/http";
import { type Item, sortEvents } from "../../lib/shape";
import { requireStaff } from "./authz";

export const handler: APIGatewayProxyHandlerV2WithJWTAuthorizer = async (event) => {
  if (!requireStaff(event)) return forbidden();

  const { Items } = await getDocClient().send(
    new QueryCommand({
      TableName: process.env.TABLE_NAME ?? "",
      IndexName: GSI1,
      KeyConditionExpression: "GSI1PK = :pk",
      ExpressionAttributeValues: { ":pk": EVENTS_ALL_GSI1PK },
    }),
  );

  return json(200, AdminEventListResponse.parse({ items: sortEvents((Items ?? []) as Item[]) }));
};
