/**
 * GET /admin/series · POST /admin/series (staff) — the series list and its
 * editor (partner content API). A series carries the rights
 * defaults and the syndication delay every asset in it inherits, so
 * "set once per series" is a real property of the data, not a convention.
 *
 * Create derives a deterministic id from the name (a duplicate name is a
 * conflict, not a second series). Update merges the editable fields.
 */
import { GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { AdminSeriesListResponse, AdminSeriesUpsertRequest, Series } from "@niltv/types";
import type { APIGatewayProxyHandlerV2WithJWTAuthorizer } from "aws-lambda";
import { GSI1, SERIES_ALL_GSI1PK, getDocClient, seriesKey } from "../../lib/db";
import { forbidden, json, notFound } from "../../lib/http";
import { requireStaff } from "./authz";
import { badRequest, conflict, isConditionalCheckFailed, parseJsonBody, slug } from "./util";

export const handler: APIGatewayProxyHandlerV2WithJWTAuthorizer = async (event) => {
  if (!requireStaff(event)) return forbidden();
  const db = getDocClient();
  const table = process.env.TABLE_NAME ?? "";

  if (event.requestContext?.http?.method === "GET") {
    const out = await db.send(
      new QueryCommand({
        TableName: table,
        IndexName: GSI1,
        KeyConditionExpression: "GSI1PK = :pk",
        ExpressionAttributeValues: { ":pk": SERIES_ALL_GSI1PK },
      }),
    );
    const series = (out.Items ?? [])
      .map((item) => Series.safeParse(item))
      .filter((r): r is { success: true; data: Series } => r.success)
      .map((r) => r.data);
    return json(200, AdminSeriesListResponse.parse({ series }));
  }

  const body = parseJsonBody(event);
  if (body === undefined) return badRequest("request body is not valid JSON");
  const parsed = AdminSeriesUpsertRequest.safeParse(body);
  if (!parsed.success) return badRequest(parsed.error.issues.map((i) => i.message).join("; "));
  const request = parsed.data;
  const now = new Date().toISOString();

  if (request.id !== undefined) {
    const { Item: existing } = await db.send(new GetCommand({ TableName: table, Key: seriesKey(request.id) }));
    if (!existing) return notFound();
    const current = Series.parse(existing);
    const next = Series.parse({
      ...current,
      name: request.name,
      ...(request.kind !== undefined ? { kind: request.kind } : {}),
      ...(request.channelId !== undefined ? { channelId: request.channelId } : {}),
      ...(request.about !== undefined ? { about: request.about } : {}),
      ...(request.coverUrl !== undefined ? { coverUrl: request.coverUrl } : {}),
      ...(request.defaultRights !== undefined ? { defaultRights: request.defaultRights } : {}),
      ...(request.syndicationDelayDays !== undefined ? { syndicationDelayDays: request.syndicationDelayDays } : {}),
      updatedAt: now,
    });
    await db.send(
      new PutCommand({
        TableName: table,
        Item: { ...seriesKey(next.id), ...next, GSI1PK: SERIES_ALL_GSI1PK, GSI1SK: next.name },
        ConditionExpression: "attribute_exists(PK)",
      }),
    );
    return json(200, next);
  }

  const entity = Series.parse({
    id: slug(request.name),
    name: request.name,
    ...(request.kind !== undefined ? { kind: request.kind } : {}),
    ...(request.channelId !== undefined ? { channelId: request.channelId } : {}),
    ...(request.about !== undefined ? { about: request.about } : {}),
    ...(request.coverUrl !== undefined ? { coverUrl: request.coverUrl } : {}),
    ...(request.defaultRights !== undefined ? { defaultRights: request.defaultRights } : {}),
    ...(request.syndicationDelayDays !== undefined ? { syndicationDelayDays: request.syndicationDelayDays } : {}),
    createdAt: now,
  });
  try {
    await db.send(
      new PutCommand({
        TableName: table,
        Item: { ...seriesKey(entity.id), ...entity, GSI1PK: SERIES_ALL_GSI1PK, GSI1SK: entity.name },
        ConditionExpression: "attribute_not_exists(PK)",
      }),
    );
  } catch (err) {
    if (isConditionalCheckFailed(err)) return conflict("CONFLICT", `series ${entity.id} already exists — pass its id to update it`);
    throw err;
  }
  return json(201, entity);
};
