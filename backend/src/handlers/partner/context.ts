/**
 * Shared plumbing for the /partner/v1 handlers: the partner identity the
 * Lambda authorizer attached, the stage kill switch, and the feed URLs.
 *
 * The routes exist in every stage; PARTNER_API_ENABLED decides whether they
 * answer. Leave it off in a stage until its sample feed has been validated.
 */
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { Partner } from "@niltv/types";
import type { APIGatewayProxyEventV2WithLambdaAuthorizer, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { getDocClient, partnerKey } from "../../lib/db";
import { notFound } from "../../lib/http";

/** What the authorizer returns as context (see authorizer.ts). */
export interface PartnerAuthContext {
  partnerId: string;
}

export type PartnerEvent = APIGatewayProxyEventV2WithLambdaAuthorizer<PartnerAuthContext>;

/** True when this stage answers partner requests at all. */
export const partnerApiEnabled = (): boolean => process.env.PARTNER_API_ENABLED === "true";

/** The kill-switch response: indistinguishable from a missing route. */
export const partnerApiDisabled = (): APIGatewayProxyStructuredResultV2 => notFound();

/** Partner id from the authorizer context; undefined when the authorizer did not run (a misconfigured route). */
export function partnerIdOf(event: PartnerEvent): string | undefined {
  const value = event.requestContext?.authorizer?.lambda?.partnerId;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** The partner row, parsed to the contract (secrets and key hashes stripped by the schema). */
export async function loadPartner(partnerId: string): Promise<Partner | undefined> {
  const { Item } = await getDocClient().send(
    new GetCommand({ TableName: process.env.TABLE_NAME ?? "", Key: partnerKey(partnerId) }),
  );
  if (!Item) return undefined;
  const parsed = Partner.safeParse(Item);
  return parsed.success ? parsed.data : undefined;
}

/** How long a signed media URL is valid at minimum (weekly-aligned expiry — see lib/syndication weeklyExpiry). */
export const URL_VALIDITY_SECONDS = 7 * 24 * 3600;

/** The partner's feed URLs on the public edge, when a feed token has been issued. */
export function feedUrlsFor(partner: Partner): { mrss: string; json: string } | undefined {
  const base = process.env.PLAYBACK_BASE_URL;
  if (!base || !partner.feedToken) return undefined;
  const name = `${partner.id}-${partner.feedToken}`;
  return { mrss: `${base}/feeds/${name}.xml`, json: `${base}/feeds/${name}.json` };
}

/** The canonical site every asset links back to. */
export const canonicalBase = (): string => process.env.SITE_ORIGIN ?? "https://niltv.com";
