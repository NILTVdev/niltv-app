/**
 * GET /v1/profiles?filter=ambassador — the directory (design §4.1; ships dark
 * behind flags.ambassadorDirectory). Reads every GSI1 PROFILES#ALL page in stored
 * order (rank-first, then name); the ambassador filter narrows to
 * ambassador-status profiles ordered by rank.
 * Only explicitly cleared people appear; the contract lives in @niltv/types.
 */
import { ApiError, ProfilesListResponse } from "@niltv/types";
import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyHandlerV2 } from "aws-lambda";
import { allProfiles } from "../lib/roster";
import { forbidden, json } from "../lib/http";
import { requireOriginVerify } from "../lib/origin";
import { directoryChips, resolveThumbUrl, type Item } from "../lib/shape";
import { athleteGsiPk, getDocClient, GSI2 } from "../lib/db";

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  // Origin lockdown: only CloudFront (which injects x-origin-verify) may call.
  if (!requireOriginVerify(event)) return forbidden();

  const filter = event.queryStringParameters?.["filter"];
  if (filter !== undefined && filter !== "ambassador") {
    return json(400, ApiError.parse({ error: "INVALID_PARAM", message: "unsupported filter" }));
  }

  const profiles = await allProfiles(process.env.TABLE_NAME ?? "");
  const chips = directoryChips(profiles, filter === "ambassador");
  if (event.queryStringParameters?.["include"] === "latestVideo") {
    // Bound concurrency, and read only the newest published clip per cleared athlete.
    // The sparse creator index uses the same publication gate as /v1/content.
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(8, chips.length) }, async () => {
      while (next < chips.length) {
        const chip = chips[next++];
        if (!chip) continue;
        const page = await getDocClient().send(new QueryCommand({
          TableName: process.env.TABLE_NAME ?? "",
          IndexName: GSI2,
          KeyConditionExpression: "GSI2PK = :pk",
          ExpressionAttributeValues: { ":pk": athleteGsiPk(chip.id) },
          ScanIndexForward: false,
          Limit: 1,
        }));
        const clip = page.Items?.[0] as Item | undefined;
        if (clip && clip["athleteId"] === chip.id && typeof clip["publishedAt"] === "string") {
          chip.latestVideo = {
            id: String(clip["id"]),
            title: String(clip["title"] ?? "Latest video"),
            thumbUrl: resolveThumbUrl(clip),
            publishedAt: clip["publishedAt"],
          };
        }
      }
    }));
  }

  const body = ProfilesListResponse.parse({
    profiles: chips,
  });
  return json(200, body, "no-store");
};
