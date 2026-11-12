/**
 * Replies to a schedule event, shared by the API, the notifier and the summary.
 *
 * A vote row is an answer even with nothing ticked: that means none of these
 * times work. Adding a time asks everyone again, and an answer whose picks
 * were all removed no longer counts.
 */
import { BatchWriteCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { RsvpStatus } from "@niltv/types";
import { getDocClient, portalEventRsvpKey } from "../db";

const table = (): string => process.env.TABLE_NAME ?? "";

export interface VoteRow {
  optionIds: string[];
  at?: string | undefined;
}

export function hasAnswered(
  event: { options: readonly { id: string }[]; timesChangedAt?: string | undefined },
  vote: VoteRow | undefined,
): boolean {
  if (!vote) return false;
  if (event.timesChangedAt && (vote.at ?? "") < event.timesChangedAt) return false;
  if (vote.optionIds.length === 0) return true;
  return vote.optionIds.some((id) => event.options.some((o) => o.id === id));
}

/** Every vote and RSVP on an event. */
export async function eventReplies(id: string): Promise<{ votes: Map<string, VoteRow>; rsvps: Map<string, RsvpStatus> }> {
  const votes = new Map<string, VoteRow>();
  const rsvps = new Map<string, RsvpStatus>();
  let startKey: Record<string, unknown> | undefined;
  do {
    const page = await getDocClient().send(
      new QueryCommand({
        TableName: table(),
        KeyConditionExpression: "PK = :pk",
        ExpressionAttributeValues: { ":pk": `PEVENT#${id}` },
        ExclusiveStartKey: startKey,
      }),
    );
    for (const item of page.Items ?? []) {
      const sk = String(item["SK"] ?? "");
      if (sk.startsWith("VOTE#") && Array.isArray(item["optionIds"])) {
        votes.set(sk.slice(5), { optionIds: item["optionIds"] as string[], at: item["at"] as string | undefined });
      }
      if (sk.startsWith("RSVP#")) {
        const status = RsvpStatus.safeParse(item["status"]);
        if (status.success) rsvps.set(sk.slice(5), status.data);
      }
    }
    startKey = page.LastEvaluatedKey;
  } while (startKey);
  return { votes, rsvps };
}

type WriteRequest = { PutRequest: { Item: Record<string, unknown> } } | { DeleteRequest: { Key: Record<string, unknown> } };

async function batchWrite(requests: WriteRequest[]): Promise<void> {
  for (let i = 0; i < requests.length; i += 25) {
    let pending: WriteRequest[] = requests.slice(i, i + 25);
    for (let attempt = 0; pending.length > 0; attempt++) {
      if (attempt === 5) throw new Error("event replies: batch write did not finish");
      const out = await getDocClient().send(new BatchWriteCommand({ RequestItems: { [table()]: pending } }));
      pending = (out.UnprocessedItems?.[table()] ?? []) as WriteRequest[];
    }
  }
}

/** People who picked the locked time count as going. They can still change it. */
export const markGoing = (eventId: string, subs: readonly string[], at: string): Promise<void> =>
  batchWrite(subs.map((sub) => ({ PutRequest: { Item: { ...portalEventRsvpKey(eventId, sub), status: "going", at } } })));

/** Replies belong to a set time, so they go when the time does. */
export const clearRsvps = (eventId: string, subs: readonly string[]): Promise<void> =>
  batchWrite(subs.map((sub) => ({ DeleteRequest: { Key: { ...portalEventRsvpKey(eventId, sub) } } })));
