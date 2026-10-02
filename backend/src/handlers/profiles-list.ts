/**
 * GET /v1/profiles?filter=ambassador — the directory (design §4.1; ships dark
 * behind flags.ambassadorDirectory). Reads every GSI1 PROFILES#ALL page in stored
 * order (rank-first, then name); the ambassador filter narrows to
 * ambassador-status profiles ordered by rank.
 * Only explicitly cleared people appear; the contract lives in @niltv/types.
 */
import { ApiError, ProfilesListResponse } from "@niltv/types";
import type { APIGatewayProxyHandlerV2 } from "aws-lambda";
import { allProfiles } from "../lib/roster";
import { forbidden, json } from "../lib/http";
import { requireOriginVerify } from "../lib/origin";
import { directoryChips } from "../lib/shape";

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  // Origin lockdown: only CloudFront (which injects x-origin-verify) may call.
  if (!requireOriginVerify(event)) return forbidden();

  const filter = event.queryStringParameters?.["filter"];
  if (filter !== undefined && filter !== "ambassador") {
    return json(400, ApiError.parse({ error: "INVALID_PARAM", message: "unsupported filter" }));
  }

  const profiles = await allProfiles(process.env.TABLE_NAME ?? "");

  const body = ProfilesListResponse.parse({
    profiles: directoryChips(profiles, filter === "ambassador"),
  });
  return json(200, body, "no-store");
};
