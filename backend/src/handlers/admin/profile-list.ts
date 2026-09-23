/**
 * GET /admin/profiles (staff) — every person profile, rank-first then
 * alphabetical (the PROFILES#ALL GSI1 partition's natural order, same rows
 * the public directory reads). No pagination in the contract: the roster is
 * dashboard-scale, so we drain the query server-side.
 */
import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { AdminProfileListResponse, Profile } from "@niltv/types";
import type { APIGatewayProxyHandlerV2WithJWTAuthorizer } from "aws-lambda";
import { getDocClient, GSI1, PROFILES_ALL_GSI1PK } from "../../lib/db";
import { forbidden, json } from "../../lib/http";
import { requireStaff } from "./authz";

export const handler: APIGatewayProxyHandlerV2WithJWTAuthorizer = async (event) => {
  if (!requireStaff(event)) return forbidden();

  const db = getDocClient();
  const table = process.env.TABLE_NAME ?? "";

  const items: Record<string, unknown>[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await db.send(
      new QueryCommand({
        TableName: table,
        IndexName: GSI1,
        KeyConditionExpression: "GSI1PK = :pk",
        ExpressionAttributeValues: { ":pk": PROFILES_ALL_GSI1PK },
        ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      }),
    );
    items.push(...(page.Items ?? []));
    exclusiveStartKey = page.LastEvaluatedKey;
  } while (exclusiveStartKey !== undefined);

  return json(
    200,
    AdminProfileListResponse.parse({ items: items.map((item) => Profile.parse(item)) }),
  );
};
