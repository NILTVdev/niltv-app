/**
 * Accepted athletes with no confirmed niltv.com account yet. The roster sync
 * keeps this list (PORTAL#PENDING / APP#{applicationId}), so staff can see who
 * is missing and each person gets one invite to create an account. A row goes
 * away once the person is a portal member, or leaves the accepted list.
 */
import { DeleteCommand, GetCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { PendingAthlete } from "@niltv/types";
import { PENDING_ATHLETES_PK, getDocClient, pendingAthleteKey } from "../db";

const table = (): string => process.env.TABLE_NAME ?? "";

/** An admin can send an invite again, at most once a day per person. */
export const INVITE_COOLDOWN_MS = 24 * 60 * 60 * 1000;

function parsePending(item: Record<string, unknown> | undefined): PendingAthlete | undefined {
  if (!item) return undefined;
  const parsed = PendingAthlete.safeParse(item);
  if (!parsed.success) {
    console.warn("portal: unreadable pending athlete", item["SK"], parsed.error.issues[0]);
    return undefined;
  }
  return parsed.data;
}

export async function listPending(): Promise<PendingAthlete[]> {
  const rows: PendingAthlete[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const page = await getDocClient().send(
      new QueryCommand({
        TableName: table(),
        KeyConditionExpression: "PK = :pk",
        ExpressionAttributeValues: { ":pk": PENDING_ATHLETES_PK },
        ExclusiveStartKey: startKey,
      }),
    );
    for (const item of page.Items ?? []) {
      const row = parsePending(item);
      if (row) rows.push(row);
    }
    startKey = page.LastEvaluatedKey;
  } while (startKey);
  return rows;
}

export async function getPending(applicationId: number): Promise<PendingAthlete | undefined> {
  const out = await getDocClient().send(
    new GetCommand({ TableName: table(), Key: pendingAthleteKey(applicationId), ConsistentRead: true }),
  );
  return parsePending(out.Item);
}

/**
 * Add a row or refresh its fields. An update, not a put: an invite claimed
 * while the sync runs keeps its invitedAt, and firstSeenAt never moves.
 */
export async function savePending(row: Omit<PendingAthlete, "invitedAt">): Promise<void> {
  const { firstSeenAt, ...fields } = row;
  const optional = ["campus", "school", "sport"] as const;
  const set = Object.entries(fields).filter(([, value]) => value !== undefined);
  const remove = optional.filter((key) => fields[key] === undefined);
  const names: Record<string, string> = Object.fromEntries(
    [...set.map(([key]) => key), ...remove, "firstSeenAt"].map((key) => [`#${key}`, key]),
  );
  const values: Record<string, unknown> = Object.fromEntries(set.map(([key, value]) => [`:${key}`, value]));
  values[":firstSeenAt"] = firstSeenAt;
  const assignments = [...set.map(([key]) => `#${key} = :${key}`), "#firstSeenAt = if_not_exists(#firstSeenAt, :firstSeenAt)"];
  await getDocClient().send(
    new UpdateCommand({
      TableName: table(),
      Key: pendingAthleteKey(row.applicationId),
      UpdateExpression: `SET ${assignments.join(", ")}${remove.length ? ` REMOVE ${remove.map((key) => `#${key}`).join(", ")}` : ""}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    }),
  );
}

export async function deletePending(applicationId: number): Promise<void> {
  await getDocClient().send(new DeleteCommand({ TableName: table(), Key: pendingAthleteKey(applicationId) }));
}

/**
 * Take the right to send an invite, atomically, so a sync and an admin can
 * never both send one. Without `again` it works once per person. With it, once
 * a day. Returns the updated row, or undefined when nothing may be sent.
 */
export async function claimInvite(
  applicationId: number,
  at: Date,
  opts: { again?: boolean } = {},
): Promise<PendingAthlete | undefined> {
  const cutoff = new Date(at.getTime() - INVITE_COOLDOWN_MS).toISOString();
  try {
    const out = await getDocClient().send(
      new UpdateCommand({
        TableName: table(),
        Key: pendingAthleteKey(applicationId),
        UpdateExpression: "SET invitedAt = :at",
        ConditionExpression: opts.again
          ? "attribute_exists(PK) AND (attribute_not_exists(invitedAt) OR invitedAt < :cutoff)"
          : "attribute_exists(PK) AND attribute_not_exists(invitedAt)",
        ExpressionAttributeValues: { ":at": at.toISOString(), ...(opts.again ? { ":cutoff": cutoff } : {}) },
        ReturnValues: "ALL_NEW",
      }),
    );
    return parsePending(out.Attributes);
  } catch (err) {
    if ((err as { name?: string }).name === "ConditionalCheckFailedException") return undefined;
    throw err;
  }
}
