/**
 * GET /v1/profiles?filter=ambassador — the directory (design §4.1; ships dark
 * behind flags.ambassadorDirectory). One GSI1 PROFILES#ALL query in stored
 * order (rank-first, then name); the ambassador filter narrows to
 * ambassador-status profiles ordered by rank.
 *
 * The contract has no dedicated list schema — the response is composed
 * locally from the imported AthleteChip (composing imported schemas is
 * allowed; redeclaring shapes is not).
 */
import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { ApiError, AthleteChip } from "@niltv/types";
import type { APIGatewayProxyHandlerV2 } from "aws-lambda";
import { z } from "zod";
import { GSI1, PROFILES_ALL_GSI1PK, getDocClient } from "../lib/db";
import { forbidden, json } from "../lib/http";
import { requireOriginVerify } from "../lib/origin";
import { directoryChips, type Item } from "../lib/shape";

/** `{ profiles: AthleteChip[] }` — local composition of the imported chip schema. */
const ProfilesListResponse = z.object({ profiles: z.array(AthleteChip) });

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  // Origin lockdown: only CloudFront (which injects x-origin-verify) may call.
  if (!requireOriginVerify(event)) return forbidden();

  const filter = event.queryStringParameters?.["filter"];
  if (filter !== undefined && filter !== "ambassador") {
    return json(400, ApiError.parse({ error: "INVALID_PARAM", message: "unsupported filter" }));
  }

  const { Items } = await getDocClient().send(
    new QueryCommand({
      TableName: process.env.TABLE_NAME ?? "",
      IndexName: GSI1,
      KeyConditionExpression: "GSI1PK = :pk",
      ExpressionAttributeValues: { ":pk": PROFILES_ALL_GSI1PK },
    }),
  );

  const body = ProfilesListResponse.parse({
    profiles: directoryChips((Items ?? []) as Item[], filter === "ambassador"),
  });
  return json(200, body, "public, max-age=300");
};
