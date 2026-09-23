/**
 * GET /partner/v1/series · GET /partner/v1/channels — the series and campus
 * channels THIS partner has licensed (one handler, two routes). Nothing
 * outside the licence is listed, so the response doubles as the scope check.
 */
import { BatchGetCommand } from "@aws-sdk/lib-dynamodb";
import { PartnerChannelsResponse, PartnerSeriesResponse } from "@niltv/types";
import type { APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { channelKey, getDocClient, seriesKey, type TableKey } from "../../lib/db";
import { forbidden, json, unauthorized } from "../../lib/http";
import { requireOriginVerify } from "../../lib/origin";
import type { Item } from "../../lib/shape";
import { loadPartner, partnerApiDisabled, partnerApiEnabled, partnerIdOf, type PartnerEvent } from "./context";

async function batchGet(keys: TableKey[]): Promise<Item[]> {
  if (keys.length === 0) return [];
  const table = process.env.TABLE_NAME ?? "";
  const out = await getDocClient().send(
    new BatchGetCommand({ RequestItems: { [table]: { Keys: keys.slice(0, 100) } } }),
  );
  return (out.Responses?.[table] ?? []) as Item[];
}

const optional = (value: unknown): string | undefined => (typeof value === "string" && value.length > 0 ? value : undefined);

export const handler = async (event: PartnerEvent): Promise<APIGatewayProxyStructuredResultV2> => {
  if (!partnerApiEnabled()) return partnerApiDisabled();
  if (!requireOriginVerify(event)) return forbidden();
  const partnerId = partnerIdOf(event);
  if (!partnerId) return unauthorized();
  const partner = await loadPartner(partnerId);
  if (!partner) return unauthorized();

  const path = event.rawPath ?? event.requestContext?.http?.path ?? "";
  if (path.endsWith("/channels")) {
    const rows = await batchGet(partner.licence.channelIds.map((id) => channelKey(id)));
    rows.sort((a, b) => String(a["name"]).localeCompare(String(b["name"])));
    return json(
      200,
      PartnerChannelsResponse.parse({
        channels: rows.map((row) => ({
          id: row["id"],
          name: row["name"],
          kind: row["kind"] ?? "campus",
          ...(optional(row["about"]) ? { about: row["about"] } : {}),
        })),
      }),
      "private, max-age=300",
    );
  }

  const rows = await batchGet(partner.licence.seriesIds.map((id) => seriesKey(id)));
  rows.sort((a, b) => String(a["name"]).localeCompare(String(b["name"])));
  return json(
    200,
    PartnerSeriesResponse.parse({
      series: rows.map((row) => ({
        id: row["id"],
        name: row["name"],
        kind: row["kind"] ?? "show",
        ...(optional(row["about"]) ? { about: row["about"] } : {}),
        ...(optional(row["coverUrl"]) ? { coverUrl: row["coverUrl"] } : {}),
      })),
    }),
    "private, max-age=300",
  );
};
