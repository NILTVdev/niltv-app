/**
 * GET /v1/events — the Events tab read (design §4.1): every event in one GSI1
 * query, ordered live → upcoming (soonest first) → ended (most recent first).
 */
import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { EventsListResponse } from "@niltv/types";
import type { APIGatewayProxyHandlerV2 } from "aws-lambda";
import { EVENTS_ALL_GSI1PK, GSI1, getDocClient } from "../lib/db";
import { forbidden, json } from "../lib/http";
import { requireOriginVerify } from "../lib/origin";
import { type Item, resolveEventMedia, sortEvents, toEventCard } from "../lib/shape";

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  // Origin lockdown: only CloudFront (which injects x-origin-verify) may call.
  if (!requireOriginVerify(event)) return forbidden();

  const { Items } = await getDocClient().send(
    new QueryCommand({
      TableName: process.env.TABLE_NAME ?? "",
      IndexName: GSI1,
      KeyConditionExpression: "GSI1PK = :pk",
      ExpressionAttributeValues: { ":pk": EVENTS_ALL_GSI1PK },
    }),
  );

  const body = EventsListResponse.parse({
    // Media resolution before the card parse so billboards get their reel/art.
    events: sortEvents((Items ?? []) as Item[]).map((item) => toEventCard(resolveEventMedia(item))),
  });
  return json(200, body, "public, max-age=60");
};
