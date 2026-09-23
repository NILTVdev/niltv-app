/**
 * GET /admin/partners (staff) — every licensing partner, by name. The
 * Partner schema strips key hashes and the webhook secret on the way out.
 */
import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { AdminPartnerListResponse, Partner } from "@niltv/types";
import type { APIGatewayProxyHandlerV2WithJWTAuthorizer } from "aws-lambda";
import { GSI1, PARTNERS_ALL_GSI1PK, getDocClient } from "../../lib/db";
import { forbidden, json } from "../../lib/http";
import { requireStaff } from "./authz";

export const handler: APIGatewayProxyHandlerV2WithJWTAuthorizer = async (event) => {
  if (!requireStaff(event)) return forbidden();
  const out = await getDocClient().send(
    new QueryCommand({
      TableName: process.env.TABLE_NAME ?? "",
      IndexName: GSI1,
      KeyConditionExpression: "GSI1PK = :pk",
      ExpressionAttributeValues: { ":pk": PARTNERS_ALL_GSI1PK },
    }),
  );
  const partners = (out.Items ?? [])
    .map((item) => Partner.safeParse(item))
    .filter((r): r is { success: true; data: Partner } => r.success)
    .map((r) => r.data);
  return json(200, AdminPartnerListResponse.parse({ partners }));
};
