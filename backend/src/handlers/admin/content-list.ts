/**
 * GET /admin/content (staff) — the full content library, paginated, including
 * unpublished/unfinished rows and their transcode fields (the dashboard's
 * working view — design §4.1 admin).
 *
 * Implementation: a paginated Scan filtered to CONTENT#/META rows. A Scan is
 * fine at MVP volume (a few hundred clips); add an index (e.g. a sparse
 * CONTENT#ALL GSI partition) when the library outgrows it. Note DynamoDB
 * applies Limit BEFORE FilterExpression, so a page may return fewer than 50
 * items while still carrying a cursor — clients must follow the cursor, not
 * count items.
 *
 * Tombstones (lib/db contentTombstone: `removed: true`, no entity fields) are
 * filtered out in the Scan, and every row still goes through Content.safeParse
 * so one malformed row can never 500 the staff library.
 */
import { ScanCommand } from "@aws-sdk/lib-dynamodb";
import { AdminContentListResponse, Content } from "@niltv/types";
import type { APIGatewayProxyHandlerV2WithJWTAuthorizer } from "aws-lambda";
import { z } from "zod";
import { getDocClient } from "../../lib/db";
import { forbidden, json } from "../../lib/http";
import { requireStaff } from "./authz";
import { badRequest, CONTENT_PK_PREFIX } from "./util";

const PAGE_LIMIT = 50;

/** A resumable position is exactly a table key — nothing else may ride in via the cursor. */
const CursorKey = z.object({ PK: z.string(), SK: z.string() }).strict();
type CursorKey = z.infer<typeof CursorKey>;

/** Opaque, URL-safe page cursor ⇄ DynamoDB LastEvaluatedKey. */
export function encodeCursor(key: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(key), "utf8").toString("base64url");
}

/** Returns undefined when the cursor is not a valid encoded table key. */
export function decodeCursor(cursor: string): CursorKey | undefined {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    const result = CursorKey.safeParse(parsed);
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

export const handler: APIGatewayProxyHandlerV2WithJWTAuthorizer = async (event) => {
  if (!requireStaff(event)) return forbidden();

  const rawCursor = event.queryStringParameters?.["cursor"];
  let exclusiveStartKey: CursorKey | undefined;
  if (rawCursor !== undefined) {
    exclusiveStartKey = decodeCursor(rawCursor);
    if (exclusiveStartKey === undefined) return badRequest("invalid cursor");
  }

  const result = await getDocClient().send(
    new ScanCommand({
      TableName: process.env.TABLE_NAME ?? "",
      // `removed` is aliased rather than trusted to be an unreserved word.
      FilterExpression: "begins_with(PK, :pk) AND SK = :sk AND attribute_not_exists(#removed)",
      ExpressionAttributeNames: { "#removed": "removed" },
      ExpressionAttributeValues: { ":pk": CONTENT_PK_PREFIX, ":sk": "META" },
      Limit: PAGE_LIMIT,
      ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
    }),
  );

  // Content.safeParse strips the key/GSI attributes and validates the entity;
  // the admin view is the full entity (transcodeStatus, rightsConfirmed, …).
  // A row that fails the contract is skipped and named, never thrown.
  const items: Content[] = [];
  for (const item of result.Items ?? []) {
    const parsed = Content.safeParse(item);
    if (parsed.success) {
      items.push(parsed.data);
    } else {
      console.warn(
        `admin/content-list: skipping malformed row ${String(item["PK"])}`,
        parsed.error.issues,
      );
    }
  }

  return json(
    200,
    AdminContentListResponse.parse({
      items,
      ...(result.LastEvaluatedKey ? { cursor: encodeCursor(result.LastEvaluatedKey) } : {}),
    }),
  );
};
