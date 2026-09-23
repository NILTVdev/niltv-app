/**
 * Lambda authorizer for /partner/v1/* (HTTP API, simple response). Our API is
 * an HTTP API, which has no built-in API keys or usage plans, so this is the
 * gate: `x-api-key` → salted hash → PARTNERKEY#{hash} row → PARTNER#{id} row
 * → { isAuthorized, context: { partnerId } }. API Gateway caches the verdict
 * per header value for a few minutes (see api-stack), so a revoked key stops
 * working within that window and a suspended partner within the same.
 *
 * Fail closed on everything: no header, malformed header, unknown hash,
 * expired rotation grace, suspended partner, or any thrown error.
 */
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import type { APIGatewaySimpleAuthorizerWithContextResult, APIGatewayRequestAuthorizerEventV2 } from "aws-lambda";
import { getDocClient, partnerApiKeyKey, partnerKey } from "../../lib/db";
import { hashApiKey, looksLikeApiKey } from "../../lib/partner-keys";
import type { PartnerAuthContext } from "./context";

type Result = APIGatewaySimpleAuthorizerWithContextResult<PartnerAuthContext | Record<string, never>>;

const deny = (): Result => ({ isAuthorized: false, context: {} });

export const handler = async (event: APIGatewayRequestAuthorizerEventV2): Promise<Result> => {
  try {
    const presented = event.headers?.["x-api-key"];
    if (!looksLikeApiKey(presented)) return deny();

    const pepper = process.env.PARTNER_KEY_PEPPER ?? "";
    const table = process.env.TABLE_NAME ?? "";
    const db = getDocClient();

    const { Item: keyRow } = await db.send(
      new GetCommand({ TableName: table, Key: partnerApiKeyKey(hashApiKey(pepper, presented)) }),
    );
    if (!keyRow || typeof keyRow["partnerId"] !== "string") return deny();
    const expiresAt = keyRow["expiresAt"];
    if (typeof expiresAt === "string" && Date.parse(expiresAt) <= Date.now()) return deny();
    if (keyRow["revokedAt"] !== undefined) return deny();

    const partnerId = keyRow["partnerId"];
    const { Item: partner } = await db.send(new GetCommand({ TableName: table, Key: partnerKey(partnerId) }));
    if (!partner || partner["status"] !== "active") return deny();

    return { isAuthorized: true, context: { partnerId } };
  } catch (err) {
    console.error("partner-authorizer: denying on error", err);
    return deny();
  }
};
