/**
 * GET /partner/v1/content/{id} — one asset with signed file URLs. Anything
 * the partner may not see is 404, identical to a missing id, so a partner
 * probing ids learns nothing about what exists outside its licence.
 */
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { contentKey, getDocClient } from "../../lib/db";
import { forbidden, json, notFound, unauthorized } from "../../lib/http";
import { requireOriginVerify } from "../../lib/origin";
import type { Item } from "../../lib/shape";
import { buildAssets } from "./catalogue";
import { canonicalBase, loadPartner, partnerApiDisabled, partnerApiEnabled, partnerIdOf, type PartnerEvent } from "./context";

export const handler = async (event: PartnerEvent): Promise<APIGatewayProxyStructuredResultV2> => {
  if (!partnerApiEnabled()) return partnerApiDisabled();
  if (!requireOriginVerify(event)) return forbidden();
  const partnerId = partnerIdOf(event);
  if (!partnerId) return unauthorized();
  const partner = await loadPartner(partnerId);
  if (!partner) return unauthorized();

  const contentId = event.pathParameters?.["id"];
  if (!contentId) return notFound();

  const { Item } = await getDocClient().send(
    new GetCommand({ TableName: process.env.TABLE_NAME ?? "", Key: contentKey(contentId) }),
  );
  if (!Item) return notFound();

  const [asset] = await buildAssets([Item as Item], { partner, canonicalBase: canonicalBase() });
  if (!asset) return notFound();
  return json(200, asset, "private, max-age=60");
};
