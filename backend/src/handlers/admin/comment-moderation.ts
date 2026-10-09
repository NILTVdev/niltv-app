/**
 * Staff comment moderation (staff group only).
 *
 *   GET  /admin/comments?queue=pending|reported   the open queue, newest first
 *   GET  /admin/comments?contentId=               every live comment on a clip
 *   POST /admin/comments/{id}/approve             pending  -> visible
 *   POST /admin/comments/{id}/restore             hidden   -> visible
 *   POST /admin/comments/{id}/remove              any live -> removed (+ reason)
 *
 * Removal is a tombstone, never a delete (the content-removal rule): the row
 * keeps its body for audit, drops out of both indexes so it is never served,
 * and records who removed it and why.
 */
import { GetCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { AdminCommentActionResponse, AdminCommentRemoveRequest, AdminCommentsResponse } from "@niltv/types";
import type { APIGatewayProxyHandlerV2WithJWTAuthorizer } from "aws-lambda";
import { decodeCursor, encodeCursor, toAdminComment } from "../../lib/comments";
import {
  COMMENT_QUEUE_GSI2PK,
  commentKey,
  commentListGsi,
  getDocClient,
  isConditionalFailure,
} from "../../lib/db";
import { forbidden, json, notFound } from "../../lib/http";
import type { Item } from "../../lib/shape";
import { requireStaff } from "./authz";
import { badRequest, parseJsonBody } from "./util";

const PAGE_SIZE = 50;

export const handler: APIGatewayProxyHandlerV2WithJWTAuthorizer = async (event) => {
  if (!requireStaff(event)) return forbidden();

  const table = process.env.TABLE_NAME ?? "";
  const db = getDocClient();
  const method = event.requestContext.http.method.toUpperCase();
  const commentId = event.pathParameters?.["id"];

  if (!commentId) {
    if (method !== "GET") return json(405, { error: "METHOD_NOT_ALLOWED" });
    const qs = event.queryStringParameters ?? {};
    const contentId = qs["contentId"];
    const queue = qs["queue"];
    if (!contentId && queue !== "pending" && queue !== "reported") {
      return badRequest("pass queue=pending|reported or contentId");
    }
    const index = contentId ? "GSI1" : "GSI2";
    const pkAttr = `${index}PK`;
    const pk = contentId ? commentListGsi(contentId, "", "").GSI1PK : COMMENT_QUEUE_GSI2PK;
    const cursor = decodeCursor(qs["cursor"], pkAttr, pk);
    if (cursor === "invalid") return badRequest("invalid cursor");

    const page = await db.send(
      new QueryCommand({
        TableName: table,
        IndexName: index,
        KeyConditionExpression: `${pkAttr} = :pk`,
        ExpressionAttributeValues: { ":pk": pk },
        ScanIndexForward: false,
        Limit: PAGE_SIZE,
        ...(cursor ? { ExclusiveStartKey: cursor } : {}),
      }),
    );
    const want = queue === "pending" ? "pending" : queue === "reported" ? "hidden" : undefined;
    const rows = ((page.Items ?? []) as Item[]).filter((r) => want === undefined || r["status"] === want);
    const nextCursor = encodeCursor(page.LastEvaluatedKey);
    return json(
      200,
      AdminCommentsResponse.parse({ comments: rows.map(toAdminComment), ...(nextCursor ? { nextCursor } : {}) }),
      "private, no-store",
    );
  }

  if (method !== "POST") return json(405, { error: "METHOD_NOT_ALLOWED" });
  const path = event.rawPath ?? event.requestContext.http.path ?? "";
  const action = path.endsWith("/approve")
    ? "approve"
    : path.endsWith("/restore")
      ? "restore"
      : path.endsWith("/remove")
        ? "remove"
        : undefined;
  if (action === undefined) return notFound();

  const { Item: row } = await db.send(new GetCommand({ TableName: table, Key: commentKey(commentId) }));
  if (!row) return notFound();

  const staffSub = String(event.requestContext.authorizer?.jwt?.claims?.["sub"] ?? "staff");
  const now = new Date().toISOString();
  const listKey = commentListGsi(String(row["contentId"]), String(row["createdAt"]), commentId);

  try {
    if (action === "remove") {
      const parsed = AdminCommentRemoveRequest.safeParse(parseJsonBody(event));
      if (!parsed.success) return badRequest(parsed.error.issues.map((i) => i.message).join("; "));
      await db.send(
        new UpdateCommand({
          TableName: table,
          Key: commentKey(commentId),
          UpdateExpression:
            "SET #status = :removed, removedAt = :now, removedBy = :by, removalReason = :reason REMOVE GSI1PK, GSI1SK, GSI2PK, GSI2SK",
          ConditionExpression: "attribute_exists(PK) AND #status <> :removed AND #status <> :deleted",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: {
            ":removed": "removed",
            ":deleted": "deleted",
            ":now": now,
            ":by": staffSub,
            ":reason": parsed.data.reason,
          },
        }),
      );
      return json(200, AdminCommentActionResponse.parse({ status: "removed" }));
    }

    // approve (pending) and restore (hidden) both publish the comment again.
    const from = action === "approve" ? "pending" : "hidden";
    await db.send(
      new UpdateCommand({
        TableName: table,
        Key: commentKey(commentId),
        UpdateExpression:
          "SET #status = :visible, reviewedAt = :now, reviewedBy = :by, reportCount = :zero, GSI1PK = :g1, GSI1SK = :g2 REMOVE GSI2PK, GSI2SK",
        ConditionExpression: "#status = :from",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":visible": "visible",
          ":from": from,
          ":now": now,
          ":by": staffSub,
          ":zero": 0,
          ":g1": listKey.GSI1PK,
          ":g2": listKey.GSI1SK,
        },
      }),
    );
    return json(200, AdminCommentActionResponse.parse({ status: action === "approve" ? "approved" : "restored" }));
  } catch (e) {
    // The comment changed state under the reviewer (author delete, another staffer): nothing was written.
    if (isConditionalFailure(e)) return json(409, { error: "STATE_CHANGED" });
    throw e;
  }
};
