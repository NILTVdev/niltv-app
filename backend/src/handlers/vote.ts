/**
 * POST /v1/events/{eventId}/vote (JWT) — the integrity path, design §6.3
 * verbatim. Gates in order: age claim → voting window → entry membership →
 * one transactional write (conditional Vote put + counter ADD). Every gate
 * fails closed with a typed error code the client renders as a specific UX
 * state; every accepted vote is a fact row keyed by user, so the tally can be
 * recomputed and exported independent of the display counters.
 */
import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { ApiError, VoteError, VoteRequest, VoteResponse } from "@niltv/types";
import type { APIGatewayProxyHandlerV2WithJWTAuthorizer } from "aws-lambda";
import {
  backoffDelayMs,
  entryKey,
  eventKey,
  getDocClient,
  isConditionalCheckFailed,
  isTransactionConflict,
  VOTE_TRANSACTION_ATTEMPTS,
  voteGsi,
  voteKey,
} from "../lib/db";
import { forbidden, json, notFound, unauthorized } from "../lib/http";
import { requireOriginVerify } from "../lib/origin";
import { isVoteWindowOpen, parseVoteBody } from "../lib/vote";

export const handler: APIGatewayProxyHandlerV2WithJWTAuthorizer = async (event) => {
  // Origin lockdown: only CloudFront (which injects x-origin-verify) may call.
  if (!requireOriginVerify(event)) return forbidden();

  // Fail closed: no usable sub claim → 401, never a guess (conventions §Auth).
  const claims = event.requestContext?.authorizer?.jwt?.claims;
  const sub = claims?.["sub"];
  if (typeof sub !== "string" || sub.length === 0) return unauthorized();

  const eventId = event.pathParameters?.["eventId"];
  if (!eventId) return notFound();

  // 1. Age gate — the claim is stamped from the stored USER row by the
  //    pre-token trigger (conventions §Auth: the row is the source of truth).
  //    Absent or anything but the string "true" is a deny.
  if (claims?.["custom:is18plus"] !== "true") {
    return json(403, VoteError.parse({ error: "AGE_GATE" }));
  }

  const body = parseVoteBody(event.body, event.isBase64Encoded === true);
  const parsed = VoteRequest.safeParse(body);
  if (!parsed.success) {
    return json(400, VoteError.parse({ error: "INVALID_ENTRY", message: "entryId required" }));
  }
  const { entryId } = parsed.data;

  const db = getDocClient();
  const table = process.env.TABLE_NAME ?? "";

  // 2. Window gate — status must be stored-live AND now inside the window
  //    (both checked: a scheduler lag or manual override can't extend voting).
  const { Item: eventRow } = await db.send(
    new GetCommand({ TableName: table, Key: eventKey(eventId) }),
  );
  if (!eventRow) return notFound();
  if (!isVoteWindowOpen(eventRow, new Date())) {
    return json(409, VoteError.parse({ error: "WINDOW_CLOSED" }));
  }

  // 3. The entry must belong to this event.
  const { Item: entryRow } = await db.send(
    new GetCommand({ TableName: table, Key: entryKey(eventId, entryId) }),
  );
  if (!entryRow) {
    return json(400, VoteError.parse({ error: "INVALID_ENTRY" }));
  }

  // 4. One transaction: the conditional Vote fact row (uniqueness by key =
  //    1 vote/account/event) + the display counter ADD. GSI1 mirror keys ride
  //    on the fact row for the audit export (design §5). A concurrent-burst
  //    TransactionConflict on the hot counter is retried a couple of times —
  //    a cancelled transaction never committed, so this cannot double-vote.
  const command = new TransactWriteCommand({
    TransactItems: [
      {
        Put: {
          TableName: table,
          Item: {
            ...voteKey(sub, eventId),
            ...voteGsi(eventId, entryId, sub),
            eventId,
            entryId,
            source: "app",
            createdAt: new Date().toISOString(),
          },
          ConditionExpression: "attribute_not_exists(PK)",
        },
      },
      {
        Update: {
          TableName: table,
          Key: entryKey(eventId, entryId),
          UpdateExpression: "ADD votes :one",
          ExpressionAttributeValues: { ":one": 1 },
        },
      },
    ],
  });
  for (let attempt = 0; ; attempt++) {
    try {
      await db.send(command);
      break;
    } catch (err) {
      // ConditionalCheckFailed = this account already holds a Vote row for the
      // event — the counter did NOT move (transactions are all-or-nothing).
      if (isConditionalCheckFailed(err)) {
        return json(409, VoteError.parse({ error: "ALREADY_VOTED" }));
      }
      if (isTransactionConflict(err)) {
        if (attempt < VOTE_TRANSACTION_ATTEMPTS - 1) {
          await new Promise((resolve) => setTimeout(resolve, backoffDelayMs(attempt)));
          continue;
        }
        // Contention, not a fault: nothing was written, so the voter can simply
        // tap again. Reporting it as 500 would trip the API 5xx alarm as an
        // outage and read to the client as a broken vote path.
        return json(
          503,
          ApiError.parse({
            error: "BUSY",
            message: "Too many votes landed at once. Try again in a moment.",
          }),
        );
      }
      throw err;
    }
  }

  // 5. 201 → client confirm screen + share sheet.
  return json(201, VoteResponse.parse({ status: "ok", eventId, entryId }));
};
