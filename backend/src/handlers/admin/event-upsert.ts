/**
 * POST /admin/events (staff) — create or update an event, then re-sync its
 * two lifecycle one-shots (design §6.5: "staff saves an event → the admin
 * Lambda creates two EventBridge Scheduler one-shots").
 *
 * Create: server assigns `ev-{slug(title)}-{rand}`; initial status derives
 * from the dates ONCE (an event created mid-window starts live) — from then
 * on status is owned by the transition Lambda / manual override, never
 * re-inferred.
 *
 * Update: staff-editable fields only; status and the frozen recap ride along
 * untouched. GSI1SK is rebuilt from (kept status, new startsAt) so the Events
 * tab partition stays consistent with a date change.
 */
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { AdminEventUpsertRequest, EventEntity, type EventStatus } from "@niltv/types";
import type { APIGatewayProxyHandlerV2WithJWTAuthorizer } from "aws-lambda";
import { eventGsi, eventKey, getDocClient } from "../../lib/db";
import { forbidden, json, notFound } from "../../lib/http";
import { requireStaff } from "./authz";
import { schedulesEnv, syncEventSchedules } from "./schedules";
import { badRequest, conflict, isConditionalCheckFailed, newEventId, parseJsonBody } from "./util";

/** Initial status from the dates — applied at create only (statuses are stored, never re-inferred). */
export function initialStatus(startsAt: string, endsAt: string, now: Date): EventStatus {
  if (now.getTime() >= Date.parse(endsAt)) return "ended";
  if (now.getTime() >= Date.parse(startsAt)) return "live";
  return "upcoming";
}

export const handler: APIGatewayProxyHandlerV2WithJWTAuthorizer = async (event) => {
  if (!requireStaff(event)) return forbidden();

  const body = parseJsonBody(event);
  if (body === undefined) return badRequest("request body is not valid JSON");
  const parsed = AdminEventUpsertRequest.safeParse(body);
  if (!parsed.success) return badRequest(parsed.error.issues.map((i) => i.message).join("; "));
  const request = parsed.data;
  if (Date.parse(request.endsAt) <= Date.parse(request.startsAt)) {
    return badRequest("endsAt must be after startsAt");
  }

  const db = getDocClient();
  const table = process.env.TABLE_NAME ?? "";

  let entity: EventEntity;
  let extras: Record<string, unknown> = {};

  if (request.id !== undefined) {
    // ── Update: keep status (+ frozen recap) exactly as stored ───────────
    const { Item: existing } = await db.send(
      new GetCommand({ TableName: table, Key: eventKey(request.id) }),
    );
    if (!existing) return notFound();
    entity = EventEntity.parse({ ...existing, ...request });
    if (existing["recap"] !== undefined) extras = { recap: existing["recap"] };
  } else {
    entity = EventEntity.parse({
      ...request,
      id: newEventId(request.title),
      status: initialStatus(request.startsAt, request.endsAt, new Date()),
    });
  }

  try {
    await db.send(
      new PutCommand({
        TableName: table,
        Item: {
          ...eventKey(entity.id),
          ...eventGsi(entity.status, entity.startsAt),
          ...entity,
          ...extras,
        },
        ...(request.id === undefined ? { ConditionExpression: "attribute_not_exists(PK)" } : {}),
      }),
    );
  } catch (err) {
    if (isConditionalCheckFailed(err)) {
      return conflict("CONFLICT", `event id ${entity.id} already exists — retry to draw a new id`);
    }
    throw err;
  }

  // Re-sync the lifecycle one-shots to the (possibly new) dates. After the
  // write on purpose: a scheduler hiccup must not lose the saved event.
  await syncEventSchedules(schedulesEnv(), entity.id, entity.startsAt, entity.endsAt);

  return json(request.id === undefined ? 201 : 200, entity);
};
