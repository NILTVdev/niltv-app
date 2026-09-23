/**
 * POST /admin/content (staff) — create or update a content row (design §4.1
 * admin, §6.8 step 1: "staff creates the content row in the dashboard").
 *
 * Create (no id in the body): the server assigns `c-{slug(title)}-{rand}`,
 * transcodeStatus starts at "uploading" and provider is "hls" — the row then
 * moves through the §6.8 pipeline (upload-url → transcode → publish).
 *
 * Update (id present): PATCH-like. title/description/channelId/athleteId/
 * rightsConfirmed are always written; tagging and editorial fields
 * (assetType, seriesId, featuredAthleteIds, rights, platformIds, tags,
 * summary, keywords, sport, school, contentType, sponsor, season, episode)
 * are written only when present in the body, with `null` clearing a field.
 * Pipeline-owned fields (transcodeStatus, playback/thumb paths, publishedAt,
 * counters, source) can never be written through this route. Note: editing
 * channelId/athleteId on an already-published row does NOT move its
 * GSI1/GSI2 rows — unpublish → republish to re-index.
 *
 * Content foundation: every field a staff member CHANGES is recorded in
 * `overrides`, so the enrichment pass never recomputes it; `clearOverrides`
 * hands fields back to the pass. Any change bumps syndicationUpdatedAt and
 * re-stamps the QC verdict and the syndication index.
 */
import { GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { AdminContentUpsertRequest, Content, ContentRights } from "@niltv/types";
import type { APIGatewayProxyHandlerV2WithJWTAuthorizer } from "aws-lambda";
import { contentKey, getDocClient } from "../../lib/db";
import { forbidden, json, notFound } from "../../lib/http";
import type { Item } from "../../lib/shape";
import { stampQcAndIndex } from "../../lib/syndication-index";
import { requireStaff } from "./authz";
import { badRequest, conflict, isConditionalCheckFailed, newContentId, parseJsonBody } from "./util";

/** Fields staff may set that the enrichment pass would otherwise recompute. */
const OVERRIDABLE = ["title", "description", "summary", "keywords", "sport", "school", "contentType", "contentTypes", "sponsor", "athleteId", "featuredAthleteIds"] as const;
/** Fields whose change is substantive for partners and the index. */
const TAGGING = ["assetType", "seriesId", "featuredAthleteIds", "rights", "platformIds", "tags", "sport", "school", "contentType", "contentTypes", "sponsor", "season", "episode", "title", "description", "summary", "keywords"] as const;

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export const handler: APIGatewayProxyHandlerV2WithJWTAuthorizer = async (event) => {
  if (!requireStaff(event)) return forbidden();

  const body = parseJsonBody(event);
  if (body === undefined) return badRequest("request body is not valid JSON");
  const parsed = AdminContentUpsertRequest.safeParse(body);
  if (!parsed.success) return badRequest(parsed.error.issues.map((i) => i.message).join("; "));
  const request = parsed.data;

  const db = getDocClient();
  const table = process.env.TABLE_NAME ?? "";
  const now = new Date().toISOString();

  // ── Update ─────────────────────────────────────────────────────────────
  if (request.id !== undefined) {
    const { Item: existing } = await db.send(new GetCommand({ TableName: table, Key: contentKey(request.id) }));
    if (!existing) return notFound();
    const current = existing as Item;

    // What the body sets. `undefined` = untouched, `null` = clear.
    const sets: Record<string, unknown> = {
      title: request.title,
      description: request.description,
      channelId: request.channelId,
      athleteId: request.athleteId,
      rightsConfirmed: request.rightsConfirmed,
    };
    const removes: string[] = [];
    const optional: Array<[string, unknown]> = [
      ["assetType", request.assetType],
      ["seriesId", request.seriesId],
      ["featuredAthleteIds", request.featuredAthleteIds],
      ["rights", request.rights !== undefined ? ContentRights.parse(request.rights) : undefined],
      ["platformIds", request.platformIds],
      ["tags", request.tags],
      ["summary", request.summary],
      ["keywords", request.keywords],
      ["sport", request.sport],
      ["school", request.school],
      ["contentType", request.contentType],
      ["contentTypes", request.contentTypes],
      ["sponsor", request.sponsor],
      ["season", request.season],
      ["episode", request.episode],
    ];
    for (const [field, value] of optional) {
      if (value === undefined) continue;
      if (value === null) removes.push(field);
      else sets[field] = value;
    }
    if (request.contentType) sets["contentTypeConfidence"] = 1;

    // Overrides: fields whose value actually changes, minus those handed back.
    const overrides = new Set(Array.isArray(current["overrides"]) ? (current["overrides"] as string[]) : []);
    for (const field of OVERRIDABLE) {
      if (field in sets && !same(sets[field], current[field])) overrides.add(field);
      if (removes.includes(field)) overrides.delete(field);
    }
    // Rights fields a person changed become overrides so the pass never
    // recomputes them; untouched ones keep following the origin rules.
    if (request.rights !== undefined) {
      const before = (current["rights"] ?? {}) as Record<string, unknown>;
      const after = (sets["rights"] ?? {}) as Record<string, unknown>;
      for (const field of ["status", "music", "logoCleared"]) {
        if (field in after && !same(after[field], before[field])) overrides.add(`rights.${field}`);
      }
    }
    for (const field of request.clearOverrides ?? []) overrides.delete(field);
    const changed = [...TAGGING].some((f) => (f in sets && !same(sets[f], current[f])) || removes.includes(f)) || (request.clearOverrides?.length ?? 0) > 0;
    if (changed) {
      sets["overrides"] = [...overrides];
      sets["syndicationUpdatedAt"] = now;
    }

    const names: Record<string, string> = {};
    const values: Record<string, unknown> = {};
    const clauses: string[] = [];
    for (const [field, value] of Object.entries(sets)) {
      names[`#${field}`] = field;
      values[`:${field}`] = value;
      clauses.push(`#${field} = :${field}`);
    }
    for (const field of removes) names[`#${field}`] = field;

    let updated;
    try {
      updated = await db.send(
        new UpdateCommand({
          TableName: table,
          Key: contentKey(request.id),
          ConditionExpression: "attribute_exists(PK)", // update never creates
          UpdateExpression: `SET ${clauses.join(", ")}${removes.length > 0 ? ` REMOVE ${removes.map((f) => `#${f}`).join(", ")}` : ""}`,
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
          ReturnValues: "ALL_NEW",
        }),
      );
    } catch (err) {
      if (isConditionalCheckFailed(err)) return notFound();
      throw err;
    }
    let row = (updated.Attributes ?? {}) as Item;
    if (changed) row = await stampQcAndIndex(row);
    return json(200, Content.parse(row));
  }

  // ── Create: server-assigned id, pipeline starts at "uploading" ─────────
  const provided = Object.fromEntries(
    (
      [
        ["assetType", request.assetType],
        ["seriesId", request.seriesId ?? undefined],
        ["featuredAthleteIds", request.featuredAthleteIds],
        ["rights", request.rights !== undefined ? ContentRights.parse(request.rights) : undefined],
        ["platformIds", request.platformIds],
        ["tags", request.tags],
        ["summary", request.summary],
        ["keywords", request.keywords],
        ["sport", request.sport ?? undefined],
        ["school", request.school ?? undefined],
        ["contentType", request.contentType ?? undefined],
        ["contentTypes", request.contentTypes],
        ["sponsor", request.sponsor ?? undefined],
        ["season", request.season ?? undefined],
        ["episode", request.episode ?? undefined],
      ] as Array<[string, unknown]>
    ).filter(([, v]) => v !== undefined),
  );
  const entity = Content.parse({
    id: newContentId(request.title),
    title: request.title,
    channelId: request.channelId,
    athleteId: request.athleteId,
    description: request.description,
    rightsConfirmed: request.rightsConfirmed,
    provider: "hls",
    transcodeStatus: "uploading",
    // A staff-created row's title and description are decisions, not captions.
    overrides: ["title", "description", ...Object.keys(provided).filter((f) => (OVERRIDABLE as readonly string[]).includes(f))],
    source: { kind: "upload", caption: request.description || request.title },
    ...provided,
  });

  try {
    await db.send(
      new PutCommand({
        TableName: table,
        Item: { ...contentKey(entity.id), ...entity },
        ConditionExpression: "attribute_not_exists(PK)", // the 4-char random tail makes collision ~impossible; fail loudly if it happens
      }),
    );
  } catch (err) {
    if (isConditionalCheckFailed(err)) {
      return conflict("CONFLICT", `content id ${entity.id} already exists — retry to draw a new id`);
    }
    throw err;
  }

  return json(201, entity);
};
