/**
 * fanout-push (design §6.4) — DynamoDB Stream consumer behind the content
 * publish gate: when a CONTENT row's transcodeStatus flips to "published"
 * (admin publish, or a seeded insert already published), notify everyone
 * ★-opted into its channel OR its creator, deduped per user, deep-linking to
 * the clip. Per-record failures are reported as batchItemFailures so the
 * stream retries (then DLQs) only what actually failed — an already-notified
 * record is never replayed by its neighbors' errors.
 */
import type { AttributeValue } from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import type { DynamoDBBatchResponse, DynamoDBStreamEvent } from "aws-lambda";
import { channelKey, getDocClient } from "../lib/db";
import { listTargetUserIds, pushToUsers } from "../lib/push";
import type { Item } from "../lib/shape";

/** The publish edge: newly published CONTENT META row (insert or modify). */
export function isContentPublishEdge(newImage: Item | undefined, oldImage: Item | undefined): boolean {
  if (!newImage) return false;
  if (!String(newImage["PK"] ?? "").startsWith("CONTENT#")) return false;
  if (newImage["SK"] !== "META") return false;
  if (newImage["transcodeStatus"] !== "published") return false;
  return oldImage?.["transcodeStatus"] !== "published";
}

async function fanoutContent(row: Item): Promise<void> {
  const contentId = String(row["id"] ?? String(row["PK"]).slice("CONTENT#".length));
  const channelId = String(row["channelId"] ?? "");
  const athleteId = String(row["athleteId"] ?? "");

  // Union of both target sets, deduped per user (design §6.4).
  const [channelUsers, ambassadorUsers] = await Promise.all([
    channelId ? listTargetUserIds("channel", channelId) : Promise.resolve([]),
    athleteId ? listTargetUserIds("ambassador", athleteId) : Promise.resolve([]),
  ]);
  const audience = new Set([...channelUsers, ...ambassadorUsers]);
  if (audience.size === 0) return;

  // Channel name for the title — best-effort; the clip title carries the push.
  let channelName = "NILTV";
  if (channelId) {
    const { Item: channel } = await getDocClient().send(
      new GetCommand({
        TableName: process.env.TABLE_NAME ?? "",
        Key: channelKey(channelId),
        ProjectionExpression: "#name",
        ExpressionAttributeNames: { "#name": "name" },
      }),
    );
    if (typeof channel?.["name"] === "string") channelName = channel["name"];
  }

  const result = await pushToUsers(audience, {
    title: `New on ${channelName}`,
    body: String(row["title"] ?? "A new clip just dropped"),
    data: { url: `/video/${contentId}` },
  });
  console.log(JSON.stringify({ contentId, audience: audience.size, ...result }));
}

export const handler = async (event: DynamoDBStreamEvent): Promise<DynamoDBBatchResponse> => {
  const batchItemFailures: Array<{ itemIdentifier: string }> = [];

  for (const record of event.Records) {
    const newImage = record.dynamodb?.NewImage
      ? unmarshall(record.dynamodb.NewImage as Record<string, AttributeValue>)
      : undefined;
    const oldImage = record.dynamodb?.OldImage
      ? unmarshall(record.dynamodb.OldImage as Record<string, AttributeValue>)
      : undefined;

    if (!isContentPublishEdge(newImage, oldImage)) continue;

    try {
      await fanoutContent(newImage as Item);
    } catch (err) {
      console.error("fanout failed", record.dynamodb?.SequenceNumber, err);
      if (record.dynamodb?.SequenceNumber) {
        batchItemFailures.push({ itemIdentifier: record.dynamodb.SequenceNumber });
      }
    }
  }

  return { batchItemFailures };
};
