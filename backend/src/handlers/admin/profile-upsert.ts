/**
 * POST /admin/profiles (staff) — create or update a person profile (design
 * §4.1 admin CRUD; roster entry is staff-curated at MVP).
 *
 * Create (no id): id is `ath-{slug(name)}` — deterministic on purpose, so
 * accidentally re-adding the same person trips the existence condition (409)
 * instead of forking them.
 *
 * Update (id present): the request is authoritative for every staff-editable
 * field (an omitted ambassadorRank CLEARS the rank), while system-owned
 * fields are preserved from the existing row: followers/totalViews (fact-row
 * counters), claimedBy (claim flow), and avatarUrl/coverUrl (media uploads —
 * not part of this request shape yet).
 *
 * Every write re-derives the PROFILES#ALL directory GSI row with the same
 * rank-first GSI1SK rule as scripts/seed.ts (zero-padded rank else name).
 */
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { AdminProfileUpsertRequest, Profile } from "@niltv/types";
import type { APIGatewayProxyHandlerV2WithJWTAuthorizer } from "aws-lambda";
import { getDocClient, profileKey, PROFILES_ALL_GSI1PK } from "../../lib/db";
import { forbidden, json, notFound } from "../../lib/http";
import { requireStaff } from "./authz";
import {
  badRequest,
  conflict,
  isConditionalCheckFailed,
  newProfileId,
  parseJsonBody,
  profileGsi1Sk,
} from "./util";

export const handler: APIGatewayProxyHandlerV2WithJWTAuthorizer = async (event) => {
  if (!requireStaff(event)) return forbidden();

  const body = parseJsonBody(event);
  if (body === undefined) return badRequest("request body is not valid JSON");
  const parsed = AdminProfileUpsertRequest.safeParse(body);
  if (!parsed.success) return badRequest(parsed.error.issues.map((i) => i.message).join("; "));
  const request = parsed.data;

  const db = getDocClient();
  const table = process.env.TABLE_NAME ?? "";

  /** Item writer: full replace keyed + indexed per design §5. */
  const putProfile = async (entity: Profile, mustNotExist: boolean): Promise<void> => {
    await db.send(
      new PutCommand({
        TableName: table,
        Item: {
          ...profileKey(entity.id),
          GSI1PK: PROFILES_ALL_GSI1PK,
          GSI1SK: profileGsi1Sk(entity),
          ...entity,
        },
        ...(mustNotExist ? { ConditionExpression: "attribute_not_exists(PK)" } : {}),
      }),
    );
  };

  // ── Update ─────────────────────────────────────────────────────────────
  if (request.id !== undefined) {
    const { Item: existingRow } = await db.send(
      new GetCommand({ TableName: table, Key: profileKey(request.id) }),
    );
    if (!existingRow) return notFound();
    const existing = Profile.parse(existingRow);

    const entity = Profile.parse({
      ...existing, // preserves followers/totalViews/claimedBy/avatarUrl/coverUrl
      name: request.name,
      handle: request.handle,
      school: request.school,
      sport: request.sport,
      bio: request.bio ?? existing.bio,
      statuses: request.statuses ?? existing.statuses,
      socials: request.socials ?? existing.socials,
      brands: request.brands ?? existing.brands,
      // Request-authoritative: omitted rank means "not ranked" (clears it).
      ambassadorRank: request.ambassadorRank,
      id: existing.id, // path of record — the body can never move a row
    });

    await putProfile(entity, false);
    return json(200, entity);
  }

  // ── Create ─────────────────────────────────────────────────────────────
  const entity = Profile.parse({
    id: newProfileId(request.name),
    name: request.name,
    handle: request.handle,
    school: request.school,
    sport: request.sport,
    bio: request.bio,
    statuses: request.statuses,
    ambassadorRank: request.ambassadorRank,
    socials: request.socials,
    brands: request.brands,
  });

  try {
    await putProfile(entity, true);
  } catch (err) {
    if (isConditionalCheckFailed(err)) {
      return conflict(
        "CONFLICT",
        `profile ${entity.id} already exists — pass its id to update it instead`,
      );
    }
    throw err;
  }
  return json(201, entity);
};
