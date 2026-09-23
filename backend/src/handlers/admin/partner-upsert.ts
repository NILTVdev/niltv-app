/**
 * POST /admin/partners (staff) — create or update a licensing partner
 * (partner content API).
 *
 * Create (no id): the server derives `p-{slug(name)}`, issues the API key,
 * the webhook secret and the feed token, and returns the plain key and
 * secret EXACTLY ONCE. The key is stored only as a salted hash
 * (PARTNERKEY#{hash}); the secret is a row attribute the Partner schema
 * strips from every response.
 *
 * Update (id present): scope, contact, status, webhook and category map are
 * editable; key material never moves through this route (see partner-key).
 */
import { GetCommand, PutCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { AdminPartnerCreatedResponse, AdminPartnerUpsertRequest, Partner } from "@niltv/types";
import type { APIGatewayProxyHandlerV2WithJWTAuthorizer } from "aws-lambda";
import { PARTNERS_ALL_GSI1PK, getDocClient, partnerApiKeyKey, partnerKey } from "../../lib/db";
import { forbidden, json, notFound } from "../../lib/http";
import { generateApiKey, hashApiKey, keyPrefixOf, randomToken } from "../../lib/partner-keys";
import { webhookUrlProblem } from "../../lib/webhook-url";
import { requireStaff } from "./authz";
import { badRequest, conflict, isConditionalCheckFailed, parseJsonBody, slug } from "./util";

export const handler: APIGatewayProxyHandlerV2WithJWTAuthorizer = async (event) => {
  if (!requireStaff(event)) return forbidden();

  const body = parseJsonBody(event);
  if (body === undefined) return badRequest("request body is not valid JSON");
  const parsed = AdminPartnerUpsertRequest.safeParse(body);
  if (!parsed.success) return badRequest(parsed.error.issues.map((i) => i.message).join("; "));
  const request = parsed.data;
  if (typeof request.webhookUrl === "string") {
    const problem = webhookUrlProblem(request.webhookUrl);
    if (problem) return badRequest(`webhookUrl ${problem}`);
  }

  const db = getDocClient();
  const table = process.env.TABLE_NAME ?? "";
  const now = new Date().toISOString();

  // ── Update ─────────────────────────────────────────────────────────────
  if (request.id !== undefined) {
    const { Item: existing } = await db.send(new GetCommand({ TableName: table, Key: partnerKey(request.id) }));
    if (!existing) return notFound();
    const current = Partner.parse(existing);
    const next = Partner.parse({
      ...current,
      name: request.name,
      ...(request.contact !== undefined ? { contact: request.contact } : {}),
      ...(request.status !== undefined ? { status: request.status } : {}),
      licence: { ...current.licence, ...(request.licence ?? {}) },
      ...(request.webhookUrl === null
        ? { webhookUrl: undefined }
        : request.webhookUrl !== undefined
          ? { webhookUrl: request.webhookUrl }
          : {}),
      ...(request.webhookEnabled !== undefined ? { webhookEnabled: request.webhookEnabled } : {}),
      ...(request.ipAllowlist !== undefined ? { ipAllowlist: request.ipAllowlist } : {}),
      ...(request.categoryMap !== undefined ? { categoryMap: request.categoryMap } : {}),
      updatedAt: now,
    });
    // Secrets and key bookkeeping live outside the schema — carry them over untouched.
    await db.send(
      new PutCommand({
        TableName: table,
        Item: {
          ...existing,
          ...next,
          ...partnerKey(next.id),
          GSI1PK: PARTNERS_ALL_GSI1PK,
          GSI1SK: next.name,
          // a cleared webhook URL must not survive the spread above
          ...(request.webhookUrl === null ? { webhookUrl: undefined } : {}),
        },
        ConditionExpression: "attribute_exists(PK)",
      }),
    );
    return json(200, next);
  }

  // ── Create ─────────────────────────────────────────────────────────────
  const id = `p-${slug(request.name)}`;
  const stage = process.env.STAGE ?? "dev";
  const apiKey = generateApiKey(stage);
  const keyHash = hashApiKey(process.env.PARTNER_KEY_PEPPER ?? "", apiKey);
  const webhookSecret = randomToken(48);
  const feedToken = randomToken(24);

  const entity = Partner.parse({
    id,
    name: request.name,
    ...(request.contact !== undefined ? { contact: request.contact } : {}),
    status: request.status ?? "active",
    licence: request.licence ?? {},
    feedToken,
    ...(request.webhookUrl ? { webhookUrl: request.webhookUrl } : {}),
    webhookEnabled: request.webhookEnabled ?? false,
    ipAllowlist: request.ipAllowlist ?? [],
    categoryMap: request.categoryMap ?? {},
    keyPrefix: keyPrefixOf(apiKey),
    keyRotatedAt: now,
    createdAt: now,
  });

  try {
    await db.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: table,
              Item: {
                ...partnerKey(id),
                ...entity,
                webhookSecret,
                activeKeyHash: keyHash,
                // every hash that can still authorize, newest first (partner-key.ts)
                keyHashes: [keyHash],
                GSI1PK: PARTNERS_ALL_GSI1PK,
                GSI1SK: entity.name,
              },
              ConditionExpression: "attribute_not_exists(PK)",
            },
          },
          {
            Put: {
              TableName: table,
              Item: { ...partnerApiKeyKey(keyHash), partnerId: id, keyPrefix: keyPrefixOf(apiKey), createdAt: now },
              ConditionExpression: "attribute_not_exists(PK)",
            },
          },
        ],
      }),
    );
  } catch (err) {
    if (isConditionalCheckFailed(err) || (err as { name?: string }).name === "TransactionCanceledException") {
      return conflict("CONFLICT", `partner ${id} already exists — pass its id to update it`);
    }
    throw err;
  }

  return json(201, AdminPartnerCreatedResponse.parse({ partner: entity, apiKey, webhookSecret }));
};
