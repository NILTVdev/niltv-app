/**
 * GET /admin/events/{id}/audit (staff) — the vote export, in from day one
 * (design §6.3). Reads every Vote FACT
 * row from the event's GSI1 partition, recomputes the per-entry tally, and
 * compares it against the display counters — so a drifted counter is caught
 * by inspection.
 */
import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { AdminEventAuditResponse } from "@niltv/types";
import type { APIGatewayProxyHandlerV2WithJWTAuthorizer } from "aws-lambda";
import { ENTRY_SK_PREFIX, GSI1, VOTE_SK_PREFIX, eventKey, getDocClient } from "../../lib/db";
import { forbidden, json, notFound } from "../../lib/http";
import type { Item } from "../../lib/shape";
import { requireStaff } from "./authz";

export const handler: APIGatewayProxyHandlerV2WithJWTAuthorizer = async (event) => {
  if (!requireStaff(event)) return forbidden();

  const eventId = event.pathParameters?.["id"];
  if (!eventId) return notFound();

  const db = getDocClient();
  const table = process.env.TABLE_NAME ?? "";
  const pk = eventKey(eventId).PK;

  // Entries (with display counters) from the table partition…
  const entriesOut = await db.send(
    new QueryCommand({
      TableName: table,
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :entry)",
      ExpressionAttributeValues: { ":pk": pk, ":entry": ENTRY_SK_PREFIX },
    }),
  );
  const entries = (entriesOut.Items ?? []) as Item[];
  if (entries.length === 0) {
    // Distinguish "no entries yet" from a typo'd event id.
    const { Items } = await db.send(
      new QueryCommand({
        TableName: table,
        KeyConditionExpression: "PK = :pk AND SK = :meta",
        ExpressionAttributeValues: { ":pk": pk, ":meta": "META" },
      }),
    );
    if ((Items ?? []).length === 0) return notFound();
  }

  // …and every vote fact row from the GSI1 mirror (paginated — a real event
  // partition holds one row per voter).
  const votes: Item[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await db.send(
      new QueryCommand({
        TableName: table,
        IndexName: GSI1,
        KeyConditionExpression: "GSI1PK = :pk AND begins_with(GSI1SK, :vote)",
        ExpressionAttributeValues: { ":pk": pk, ":vote": VOTE_SK_PREFIX },
        ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      }),
    );
    votes.push(...((page.Items ?? []) as Item[]));
    exclusiveStartKey = page.LastEvaluatedKey;
  } while (exclusiveStartKey);

  const factCounts = new Map<string, number>();
  for (const vote of votes) {
    const entryId = String(vote["entryId"]);
    factCounts.set(entryId, (factCounts.get(entryId) ?? 0) + 1);
  }

  const tallies = entries.map((entry) => {
    const id = String(entry["id"]);
    const counter = typeof entry["votes"] === "number" ? entry["votes"] : 0;
    const factCount = factCounts.get(id) ?? 0;
    return { entryId: id, counter, factCount, matches: counter === factCount };
  });

  return json(
    200,
    AdminEventAuditResponse.parse({
      eventId,
      generatedAt: new Date().toISOString(),
      totalVotes: votes.length,
      countersMatch:
        tallies.every((tally) => tally.matches) &&
        // …and no fact row points at an entry that no longer exists.
        [...factCounts.keys()].every((id) => tallies.some((tally) => tally.entryId === id)),
      tallies,
      votes: votes.map((vote) => ({
        entryId: String(vote["entryId"]),
        userId: String(vote["PK"]).replace(/^USER#/, ""),
        createdAt: String(vote["createdAt"]),
        source: vote["source"] === "web" ? "web" : "app",
      })),
    }),
  );
};
