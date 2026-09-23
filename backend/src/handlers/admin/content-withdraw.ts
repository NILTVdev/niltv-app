/**
 * POST /admin/content/{id}/withdraw · /restore (staff) — pull an asset from
 * every partner surface, or put it back. Withdrawal is the partner-facing
 * removal: the row keeps its GSI3 keys as a tombstone (so /changes and the
 * webhook can say "gone"), drops out of every feed on the next build, and
 * the item route answers 404. The app is untouched — withdrawing from
 * partners is not unpublishing.
 */
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { AdminContentWithdrawRequest, AdminContentWithdrawResponse } from "@niltv/types";
import type { APIGatewayProxyHandlerV2WithJWTAuthorizer } from "aws-lambda";
import { contentKey, getDocClient } from "../../lib/db";
import { forbidden, json, notFound } from "../../lib/http";
import type { Item } from "../../lib/shape";
import { stampSyndicationIndex } from "../../lib/syndication-index";
import { requireStaff } from "./authz";
import { badRequest, parseJsonBody } from "./util";

export const handler: APIGatewayProxyHandlerV2WithJWTAuthorizer = async (event) => {
  if (!requireStaff(event)) return forbidden();
  const contentId = event.pathParameters?.["id"];
  if (!contentId) return notFound();
  const path = event.rawPath ?? event.requestContext?.http?.path ?? "";
  const action = path.endsWith("/withdraw") ? "withdraw" : path.endsWith("/restore") ? "restore" : undefined;
  if (action === undefined) return notFound();

  const db = getDocClient();
  const table = process.env.TABLE_NAME ?? "";
  const { Item: row } = await db.send(new GetCommand({ TableName: table, Key: contentKey(contentId) }));
  if (!row) return notFound();
  const now = new Date().toISOString();

  if (action === "withdraw") {
    const body = parseJsonBody(event);
    if (body === undefined) return badRequest("request body is not valid JSON");
    const parsed = AdminContentWithdrawRequest.safeParse(body);
    if (!parsed.success) return badRequest(parsed.error.issues.map((i) => i.message).join("; "));
    const updated = await db.send(
      new UpdateCommand({
        TableName: table,
        Key: contentKey(contentId),
        UpdateExpression: "SET withdrawnAt = :now, withdrawnReason = :reason, syndicationUpdatedAt = :now",
        ExpressionAttributeValues: { ":now": now, ":reason": parsed.data.reason },
        ReturnValues: "ALL_NEW",
      }),
    );
    await stampSyndicationIndex(updated.Attributes as Item);
    return json(200, AdminContentWithdrawResponse.parse({ status: "withdrawn", at: now }));
  }

  const updated = await db.send(
    new UpdateCommand({
      TableName: table,
      Key: contentKey(contentId),
      UpdateExpression: "SET syndicationUpdatedAt = :now REMOVE withdrawnAt, withdrawnReason",
      ExpressionAttributeValues: { ":now": now },
      ReturnValues: "ALL_NEW",
    }),
  );
  await stampSyndicationIndex(updated.Attributes as Item);
  return json(200, AdminContentWithdrawResponse.parse({ status: "restored", at: now }));
};
