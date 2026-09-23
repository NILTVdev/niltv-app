/**
 * GET /partner/v1/me — what this key is entitled to: the partner, its
 * licence scope, its feed URLs, and how long signed media URLs stay valid.
 * The first call every partner engineer makes, and the one that proves the
 * key works before they write an adapter.
 */
import { PartnerMeResponse } from "@niltv/types";
import type { APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { forbidden, json, unauthorized } from "../../lib/http";
import { requireOriginVerify } from "../../lib/origin";
import {
  URL_VALIDITY_SECONDS,
  feedUrlsFor,
  loadPartner,
  partnerApiDisabled,
  partnerApiEnabled,
  partnerIdOf,
  type PartnerEvent,
} from "./context";

export const handler = async (event: PartnerEvent): Promise<APIGatewayProxyStructuredResultV2> => {
  if (!partnerApiEnabled()) return partnerApiDisabled();
  if (!requireOriginVerify(event)) return forbidden();
  const partnerId = partnerIdOf(event);
  if (!partnerId) return unauthorized();
  const partner = await loadPartner(partnerId);
  if (!partner) return unauthorized();

  const feeds = feedUrlsFor(partner);
  return json(
    200,
    PartnerMeResponse.parse({
      partner: { id: partner.id, name: partner.name, status: partner.status },
      licence: partner.licence,
      ...(feeds ? { feeds } : {}),
      urlValiditySeconds: URL_VALIDITY_SECONDS,
    }),
    "private, no-store",
  );
};
