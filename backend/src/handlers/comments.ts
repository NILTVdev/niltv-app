/**
 * Comments on clips (JWT). One Lambda, routed by method and path:
 *
 *   GET    /v1/comments?contentId=            list (blocks and own reports applied)
 *   POST   /v1/comments                       post (terms, rate limit, filter)
 *   PATCH  /v1/comments/{commentId}           edit own (rate limit, filter again)
 *   DELETE /v1/comments/{commentId}           delete own
 *   POST   /v1/comments/{commentId}/report    report (hidden at 3 distinct reporters)
 *   PUT    /v1/me/comment-terms               accept the community guidelines
 *
 * These live under /v1/comments, NOT /v1/content: the edge caches /v1/content*
 * for every viewer (Authorization is not in that cache key) and this list is
 * per-user.
 *
 * The author, their display name and their age bracket always come from the
 * verified token and the stored USER row, never from the request body
 * (conventions §Auth). Every authorization check fails closed.
 */
import { GetCommand, PutCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import {
  AckResponse,
  ApiError,
  COMMENT_ERROR_LOCKED,
  COMMENT_ERROR_RATE_LIMITED,
  COMMENT_ERROR_REJECTED,
  COMMENT_ERROR_TERMS_REQUIRED,
  COMMENT_REPORT_HIDE_THRESHOLD,
  CommentCreateRequest,
  CommentCreateResponse,
  CommentReportRequest,
  CommentUpdateRequest,
  CommentsListResponse,
} from "@niltv/types";
import { screenComment } from "@niltv/types/comment-filter";
import type { APIGatewayProxyHandlerV2WithJWTAuthorizer } from "aws-lambda";
import { randomUUID } from "node:crypto";
import {
  bodyHash,
  decodeCursor,
  displayName,
  encodeCursor,
  rememberBody,
  takeRateToken,
  toComment,
} from "../lib/comments";
import {
  BLOCK_SK_PREFIX,
  REPORTED_SK_PREFIX,
  commentKey,
  commentListGsi,
  commentQueueGsi,
  commentReportKey,
  contentKey,
  getDocClient,
  isConditionalCheckFailed,
  isConditionalFailure,
  reportedKey,
  userCommentKey,
  userKey,
} from "../lib/db";
import { badRequest, forbidden, json, notFound, parseJsonBody, unauthorized } from "../lib/http";
import { requireOriginVerify } from "../lib/origin";
import type { Item } from "../lib/shape";

const PAGE_SIZE = 20;
const MAX_QUERY_PAGES = 5;

const err = (status: number, code: string) => json(status, ApiError.parse({ error: code }));

/** Every id of `prefix#…` rows in the user's partition (blocks, own reports). */
async function userSet(table: string, sub: string, prefix: string): Promise<Set<string>> {
  const db = getDocClient();
  const ids = new Set<string>();
  let start: Record<string, unknown> | undefined;
  do {
    const page = await db.send(
      new QueryCommand({
        TableName: table,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :p)",
        ExpressionAttributeValues: { ":pk": userKey(sub).PK, ":p": prefix },
        ProjectionExpression: "SK",
        ...(start ? { ExclusiveStartKey: start } : {}),
      }),
    );
    for (const row of page.Items ?? []) ids.add(String(row["SK"]).slice(prefix.length));
    start = page.LastEvaluatedKey;
  } while (start);
  return ids;
}

async function listComments(table: string, sub: string, contentId: string, rawCursor: string | undefined) {
  const db = getDocClient();
  const { Item: content } = await db.send(new GetCommand({ TableName: table, Key: contentKey(contentId) }));
  if (!content || content["removed"] === true) return notFound();

  const pk = commentListGsi(contentId, "", "").GSI1PK;
  const cursor = decodeCursor(rawCursor, "GSI1PK", pk);
  if (cursor === "invalid") return badRequest("invalid cursor");

  const [blocked, reported] = await Promise.all([
    userSet(table, sub, BLOCK_SK_PREFIX),
    userSet(table, sub, REPORTED_SK_PREFIX),
  ]);

  const out: Item[] = [];
  let start = cursor;
  let lastKey: Record<string, unknown> | undefined;
  for (let i = 0; i < MAX_QUERY_PAGES && out.length < PAGE_SIZE; i++) {
    const page = await db.send(
      new QueryCommand({
        TableName: table,
        IndexName: "GSI1",
        KeyConditionExpression: "GSI1PK = :pk",
        ExpressionAttributeValues: { ":pk": pk },
        ScanIndexForward: false,
        Limit: PAGE_SIZE,
        ...(start ? { ExclusiveStartKey: start } : {}),
      }),
    );
    for (const row of (page.Items ?? []) as Item[]) {
      const authorId = String(row["authorId"]);
      const id = String(row["id"]);
      if (blocked.has(authorId) || reported.has(id)) continue;
      // Pending (filter-held) comments are visible to their author only.
      if (row["status"] === "pending" && authorId !== sub) continue;
      if (row["status"] !== "visible" && row["status"] !== "pending") continue;
      out.push(row);
    }
    lastKey = page.LastEvaluatedKey;
    if (!lastKey) break;
    start = lastKey;
  }
  const nextCursor = encodeCursor(lastKey);
  return json(
    200,
    CommentsListResponse.parse({ comments: out.map(toComment), ...(nextCursor ? { nextCursor } : {}) }),
    "private, no-store",
  );
}

async function createComment(
  table: string,
  sub: string,
  event: Parameters<APIGatewayProxyHandlerV2WithJWTAuthorizer>[0],
) {
  const parsed = CommentCreateRequest.safeParse(parseJsonBody(event.body, event.isBase64Encoded));
  if (!parsed.success) return badRequest(parsed.error.issues.map((i) => i.message).join("; "));
  const { body, contentId } = parsed.data;

  const db = getDocClient();
  const { Item: user } = await db.send(new GetCommand({ TableName: table, Key: userKey(sub) }));
  if (!user) return forbidden();
  if (typeof user["commentTermsAcceptedAt"] !== "string") return err(403, COMMENT_ERROR_TERMS_REQUIRED);

  const { Item: content } = await db.send(new GetCommand({ TableName: table, Key: contentKey(contentId) }));
  if (!content || content["removed"] === true) return notFound();

  const hash = bodyHash(body);
  const rate = await takeRateToken(table, sub, hash);
  if (rate !== "ok") return err(429, COMMENT_ERROR_RATE_LIMITED);

  // is18plus comes from the stored row. Anything but a literal `true` is a minor (fail closed).
  const is18plus = user["is18plus"] === true;
  const screened = screenComment(body, { minor: !is18plus });
  if (screened.verdict === "reject") {
    console.info("comment rejected", { sub, reason: screened.reason });
    return err(422, COMMENT_ERROR_REJECTED);
  }

  const id = randomUUID();
  const createdAt = new Date().toISOString();
  const status = screened.verdict === "hold" ? "pending" : "visible";
  const item: Item = {
    ...commentKey(id),
    ...commentListGsi(contentId, createdAt, id),
    ...(status === "pending" ? commentQueueGsi(createdAt, id) : {}),
    id,
    contentId,
    authorId: sub,
    authorName: displayName(user["name"]),
    authorIs18plus: is18plus,
    body,
    status,
    reportCount: 0,
    createdAt,
  };
  await db.send(
    new TransactWriteCommand({
      TransactItems: [
        { Put: { TableName: table, Item: item, ConditionExpression: "attribute_not_exists(PK)" } },
        { Put: { TableName: table, Item: { ...userCommentKey(sub, id), contentId, createdAt } } },
      ],
    }),
  );
  await rememberBody(table, sub, hash).catch((e) => console.error("comment: rememberBody failed", e));
  return json(201, CommentCreateResponse.parse({ comment: toComment(item) }));
}

async function editComment(
  table: string,
  sub: string,
  commentId: string,
  event: Parameters<APIGatewayProxyHandlerV2WithJWTAuthorizer>[0],
) {
  const parsed = CommentUpdateRequest.safeParse(parseJsonBody(event.body, event.isBase64Encoded));
  if (!parsed.success) return badRequest(parsed.error.issues.map((i) => i.message).join("; "));
  const body = parsed.data.body;

  const db = getDocClient();
  const { Item: row } = await db.send(new GetCommand({ TableName: table, Key: commentKey(commentId) }));
  // Someone else's comment is indistinguishable from a missing one.
  if (!row || row["authorId"] !== sub || row["status"] === "removed" || row["status"] === "deleted") return notFound();
  if (row["status"] === "hidden") return err(403, COMMENT_ERROR_LOCKED);

  const { Item: user } = await db.send(new GetCommand({ TableName: table, Key: userKey(sub) }));
  if (!user) return forbidden();
  if (typeof user["commentTermsAcceptedAt"] !== "string") return err(403, COMMENT_ERROR_TERMS_REQUIRED);

  const hash = bodyHash(body);
  const rate = await takeRateToken(table, sub, hash);
  if (rate !== "ok") return err(429, COMMENT_ERROR_RATE_LIMITED);

  const screened = screenComment(body, { minor: user["is18plus"] !== true });
  if (screened.verdict === "reject") return err(422, COMMENT_ERROR_REJECTED);

  const status = screened.verdict === "hold" ? "pending" : "visible";
  const editedAt = new Date().toISOString();
  const createdAt = String(row["createdAt"]);
  const queue = commentQueueGsi(createdAt, commentId);
  try {
    const updated = await db.send(
      new UpdateCommand({
        TableName: table,
        Key: commentKey(commentId),
        UpdateExpression:
          status === "pending"
            ? "SET #body = :body, #status = :status, editedAt = :at, GSI2PK = :q1, GSI2SK = :q2"
            : "SET #body = :body, #status = :status, editedAt = :at REMOVE GSI2PK, GSI2SK",
        // Staff action or auto-hide that landed meanwhile wins over the edit.
        ConditionExpression: "authorId = :sub AND (#status = :visible OR #status = :pending)",
        ExpressionAttributeNames: { "#body": "body", "#status": "status" },
        ExpressionAttributeValues: {
          ":body": body,
          ":status": status,
          ":at": editedAt,
          ":sub": sub,
          ":visible": "visible",
          ":pending": "pending",
          ...(status === "pending" ? { ":q1": queue.GSI2PK, ":q2": queue.GSI2SK } : {}),
        },
        ReturnValues: "ALL_NEW",
      }),
    );
    await rememberBody(table, sub, hash).catch((e) => console.error("comment: rememberBody failed", e));
    return json(200, CommentCreateResponse.parse({ comment: toComment(updated.Attributes as Item) }));
  } catch (e) {
    if (isConditionalFailure(e)) return err(403, COMMENT_ERROR_LOCKED);
    throw e;
  }
}

async function deleteComment(table: string, sub: string, commentId: string) {
  const db = getDocClient();
  const { Item: row } = await db.send(new GetCommand({ TableName: table, Key: commentKey(commentId) }));
  if (!row || row["authorId"] !== sub) return notFound();
  const ack = json(200, AckResponse.parse({ status: "ok" }));
  // Already gone (author-deleted, or removed by staff and kept for audit): idempotent ok.
  if (row["status"] === "deleted" || row["status"] === "removed") return ack;

  const reported = Number(row["reportCount"] ?? 0) > 0 || row["status"] === "hidden";
  if (reported) {
    // Keep a bare tombstone so staff history and report rows stay coherent.
    await db.send(
      new UpdateCommand({
        TableName: table,
        Key: commentKey(commentId),
        UpdateExpression: "SET #status = :deleted, #body = :empty, deletedAt = :now REMOVE GSI1PK, GSI1SK, GSI2PK, GSI2SK",
        ConditionExpression: "authorId = :sub",
        ExpressionAttributeNames: { "#status": "status", "#body": "body" },
        ExpressionAttributeValues: { ":deleted": "deleted", ":empty": "", ":now": new Date().toISOString(), ":sub": sub },
      }),
    );
    return ack;
  }
  await db.send(
    new TransactWriteCommand({
      TransactItems: [
        { Delete: { TableName: table, Key: commentKey(commentId), ConditionExpression: "authorId = :sub", ExpressionAttributeValues: { ":sub": sub } } },
        { Delete: { TableName: table, Key: userCommentKey(sub, commentId) } },
      ],
    }),
  ).catch((e) => {
    if (!isConditionalCheckFailed(e)) throw e;
  });
  return ack;
}

async function reportComment(
  table: string,
  sub: string,
  commentId: string,
  event: Parameters<APIGatewayProxyHandlerV2WithJWTAuthorizer>[0],
) {
  const parsed = CommentReportRequest.safeParse(parseJsonBody(event.body, event.isBase64Encoded));
  if (!parsed.success) return badRequest(parsed.error.issues.map((i) => i.message).join("; "));

  const db = getDocClient();
  const { Item: row } = await db.send(new GetCommand({ TableName: table, Key: commentKey(commentId) }));
  if (!row || row["status"] === "deleted" || row["status"] === "removed") return notFound();
  if (row["authorId"] === sub) return badRequest("you can't report your own comment");

  const ack = json(200, AckResponse.parse({ status: "ok" }));
  const now = new Date().toISOString();
  try {
    await db.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: table,
              Item: { ...commentReportKey(commentId, sub), reason: parsed.data.reason, createdAt: now },
              ConditionExpression: "attribute_not_exists(PK)",
            },
          },
          { Put: { TableName: table, Item: { ...reportedKey(sub, commentId), createdAt: now } } },
          {
            Update: {
              TableName: table,
              Key: commentKey(commentId),
              UpdateExpression: "ADD reportCount :one",
              ConditionExpression: "attribute_exists(PK)",
              ExpressionAttributeValues: { ":one": 1 },
            },
          },
        ],
      }),
    );
  } catch (e) {
    // Already reported by this user: idempotent ok, count untouched.
    if (isConditionalCheckFailed(e)) return ack;
    throw e;
  }

  // Hide for everyone once enough DISTINCT reporters have reported. The
  // condition makes this safe under concurrent reports and a no-op otherwise.
  const queue = commentQueueGsi(String(row["createdAt"]), commentId);
  try {
    await db.send(
      new UpdateCommand({
        TableName: table,
        Key: commentKey(commentId),
        UpdateExpression:
          "SET #status = :hidden, hiddenAt = :now, GSI2PK = :q1, GSI2SK = :q2 REMOVE GSI1PK, GSI1SK",
        ConditionExpression: "(#status = :visible OR #status = :pending) AND reportCount >= :threshold",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":hidden": "hidden",
          ":visible": "visible",
          ":pending": "pending",
          ":now": now,
          ":q1": queue.GSI2PK,
          ":q2": queue.GSI2SK,
          ":threshold": COMMENT_REPORT_HIDE_THRESHOLD,
        },
      }),
    );
  } catch (e) {
    if (!isConditionalFailure(e)) throw e;
  }
  return ack;
}

async function acceptTerms(table: string, sub: string) {
  try {
    await getDocClient().send(
      new UpdateCommand({
        TableName: table,
        Key: userKey(sub),
        UpdateExpression: "SET commentTermsAcceptedAt = if_not_exists(commentTermsAcceptedAt, :now)",
        ConditionExpression: "attribute_exists(PK)",
        ExpressionAttributeValues: { ":now": new Date().toISOString() },
      }),
    );
  } catch (e) {
    if (isConditionalFailure(e)) return forbidden();
    throw e;
  }
  return json(200, AckResponse.parse({ status: "ok" }));
}

export const handler: APIGatewayProxyHandlerV2WithJWTAuthorizer = async (event) => {
  if (!requireOriginVerify(event)) return forbidden();

  const sub = event.requestContext?.authorizer?.jwt?.claims?.["sub"];
  if (typeof sub !== "string" || sub.length === 0) return unauthorized();

  const table = process.env.TABLE_NAME ?? "";
  const method = event.requestContext.http.method.toUpperCase();
  const path = event.rawPath ?? event.requestContext.http.path ?? "";
  const commentId = event.pathParameters?.["commentId"];

  if (commentId) {
    if (path.endsWith("/report")) {
      if (method === "POST") return reportComment(table, sub, commentId, event);
    } else if (method === "PATCH") {
      return editComment(table, sub, commentId, event);
    } else if (method === "DELETE") {
      return deleteComment(table, sub, commentId);
    }
  } else if (path.endsWith("/comment-terms")) {
    if (method === "PUT") return acceptTerms(table, sub);
  } else if (method === "GET") {
    const contentId = event.queryStringParameters?.["contentId"];
    if (!contentId) return badRequest("contentId is required");
    return listComments(table, sub, contentId, event.queryStringParameters?.["cursor"]);
  } else if (method === "POST") {
    return createComment(table, sub, event);
  }
  return json(405, ApiError.parse({ error: "METHOD_NOT_ALLOWED" }));
};
