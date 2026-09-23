/**
 * POST /admin/events/{id}/entries · DELETE /admin/events/{id}/entries/{entryId}
 * (staff) — finalist roster management.
 *
 * Upsert is keyed deterministically off the athlete (`en-{athlete}`), so one
 * athlete holds at most one entry per event; re-posting the same athlete
 * updates their audition link without forking the entry or touching its vote
 * counter. Votes are NEVER writable through this route.
 */
import { DeleteCommand, GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { AdminEntryUpsertRequest, ApiError, Entry } from "@niltv/types";
import type { APIGatewayProxyHandlerV2WithJWTAuthorizer } from "aws-lambda";
import { athleteGsiPk, entryKey, eventKey, getDocClient, profileKey } from "../../lib/db";
import { forbidden, json, notFound } from "../../lib/http";
import { requireStaff } from "./authz";
import { badRequest, isConditionalCheckFailed, newEntryId, parseJsonBody } from "./util";

export const handler: APIGatewayProxyHandlerV2WithJWTAuthorizer = async (event) => {
  if (!requireStaff(event)) return forbidden();

  const eventId = event.pathParameters?.["id"];
  if (!eventId) return notFound();

  const db = getDocClient();
  const table = process.env.TABLE_NAME ?? "";
  const method = event.requestContext.http.method.toUpperCase();

  if (method === "DELETE") {
    const entryId = event.pathParameters?.["entryId"];
    if (!entryId) return notFound();
    try {
      await db.send(
        new DeleteCommand({
          TableName: table,
          Key: entryKey(eventId, entryId),
          ConditionExpression: "attribute_exists(PK)",
        }),
      );
    } catch (err) {
      if (isConditionalCheckFailed(err)) return notFound();
      throw err;
    }
    return json(200, { status: "ok" });
  }

  if (method !== "POST") return json(405, ApiError.parse({ error: "METHOD_NOT_ALLOWED" }));

  const body = parseJsonBody(event);
  if (body === undefined) return badRequest("request body is not valid JSON");
  const parsed = AdminEntryUpsertRequest.safeParse(body);
  if (!parsed.success) return badRequest(parsed.error.issues.map((i) => i.message).join("; "));
  const request = parsed.data;

  // Both sides of the join must exist — a typo'd id must not mint a dangling
  // finalist (the public detail would silently drop it, design shape.ts note).
  const [{ Item: eventRow }, { Item: profileRow }] = await Promise.all([
    db.send(new GetCommand({ TableName: table, Key: eventKey(eventId) })),
    db.send(new GetCommand({ TableName: table, Key: profileKey(request.athleteId) })),
  ]);
  if (!eventRow) return notFound();
  if (!profileRow) return badRequest(`athlete ${request.athleteId} does not exist`);

  const entryId = request.id ?? newEntryId(request.athleteId);

  // Update-in-place first (preserves the live vote counter); fall back to a
  // fresh row at votes:0 when the entry doesn't exist yet.
  try {
    const updated = await db.send(
      new UpdateCommand({
        TableName: table,
        Key: entryKey(eventId, entryId),
        ConditionExpression: "attribute_exists(PK)",
        UpdateExpression:
          request.auditionContentId !== undefined
            ? "SET athleteId = :athleteId, auditionContentId = :audition, GSI1PK = :gsi1pk"
            : "SET athleteId = :athleteId, GSI1PK = :gsi1pk REMOVE auditionContentId",
        ExpressionAttributeValues: {
          ":athleteId": request.athleteId,
          ":gsi1pk": athleteGsiPk(request.athleteId),
          ...(request.auditionContentId !== undefined ? { ":audition": request.auditionContentId } : {}),
        },
        ReturnValues: "ALL_NEW",
      }),
    );
    return json(200, Entry.parse(updated.Attributes ?? {}));
  } catch (err) {
    if (!isConditionalCheckFailed(err)) throw err;
  }

  const entity = Entry.parse({
    id: entryId,
    eventId,
    athleteId: request.athleteId,
    ...(request.auditionContentId !== undefined ? { auditionContentId: request.auditionContentId } : {}),
    votes: 0,
  });
  await db.send(
    new PutCommand({
      TableName: table,
      Item: {
        ...entryKey(eventId, entryId),
        GSI1PK: athleteGsiPk(request.athleteId),
        GSI1SK: `ENTRY#${eventId}`,
        ...entity,
      },
      ConditionExpression: "attribute_not_exists(PK)", // lost race with a concurrent create → 500, retryable
    }),
  );
  return json(201, entity);
};
