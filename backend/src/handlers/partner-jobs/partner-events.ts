/**
 * partner-events — DynamoDB stream consumer (same stream the push fanout
 * reads). Turns content-row transitions into partner lifecycle events and
 * queues one webhook delivery per interested partner:
 *
 *   GSI3 keys appear                       → content.published
 *   GSI3SK changes (edit stamp bumped)     → content.updated
 *   withdrawnAt appears                    → content.withdrawn
 *   withdrawnAt disappears (restore)       → content.updated
 *
 * "Interested" = active, webhook enabled, URL set, and the row is in the
 * partner's licence scope. Delivery itself, with signing and retries, is
 * webhook-deliver's job; this function only decides who hears what.
 */
import { SQSClient, SendMessageBatchCommand } from "@aws-sdk/client-sqs";
import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import { Partner, type PartnerEventType } from "@niltv/types";
import type { DynamoDBBatchResponse, DynamoDBRecord, DynamoDBStreamEvent } from "aws-lambda";
import { randomUUID } from "node:crypto";
import { GSI1, PARTNERS_ALL_GSI1PK, getDocClient } from "../../lib/db";
import type { Item } from "../../lib/shape";
import { partnerScope, syndicationUpdatedAtOf } from "../../lib/syndication";

let sqs: SQSClient | undefined;
const getSqs = (): SQSClient => (sqs ??= new SQSClient({ region: process.env.AWS_REGION ?? "us-east-1" }));

export interface QueuedDelivery {
  partnerId: string;
  eventId: string;
  type: PartnerEventType;
  contentId: string;
  updatedAt: string;
}

/** The event a row transition represents, or undefined when partners need not hear about it. */
export function eventFor(oldImage: Item | undefined, newImage: Item | undefined): PartnerEventType | undefined {
  if (!newImage || typeof newImage["id"] !== "string") return undefined;
  if (!String(newImage["PK"] ?? "").startsWith("CONTENT#") || newImage["SK"] !== "META") return undefined;
  const hadIndex = typeof oldImage?.["GSI3PK"] === "string";
  const hasIndex = typeof newImage["GSI3PK"] === "string";
  const wasWithdrawn = typeof oldImage?.["withdrawnAt"] === "string";
  const isWithdrawn = typeof newImage["withdrawnAt"] === "string";
  if (!hasIndex) return undefined; // not a candidate (or no longer one): nothing to announce yet
  if (isWithdrawn && !wasWithdrawn) return "content.withdrawn";
  if (isWithdrawn) return undefined; // already withdrawn; further edits are noise
  if (!hadIndex) return "content.published";
  if (wasWithdrawn) return "content.updated";
  if (oldImage?.["GSI3SK"] !== newImage["GSI3SK"]) return "content.updated";
  return undefined;
}

async function subscribedPartners(table: string): Promise<Partner[]> {
  const out = await getDocClient().send(
    new QueryCommand({
      TableName: table,
      IndexName: GSI1,
      KeyConditionExpression: "GSI1PK = :pk",
      ExpressionAttributeValues: { ":pk": PARTNERS_ALL_GSI1PK },
    }),
  );
  return (out.Items ?? [])
    .map((item) => Partner.safeParse(item))
    .filter((r): r is { success: true; data: Partner } => r.success)
    .map((r) => r.data)
    .filter((p) => p.status === "active" && p.webhookEnabled && p.webhookUrl);
}

const image = (record: DynamoDBRecord, which: "OldImage" | "NewImage"): Item | undefined => {
  const raw = record.dynamodb?.[which];
  return raw ? (unmarshall(raw as Parameters<typeof unmarshall>[0]) as Item) : undefined;
};

export const handler = async (event: DynamoDBStreamEvent): Promise<DynamoDBBatchResponse> => {
  const table = process.env.TABLE_NAME ?? "";
  const queueUrl = process.env.WEBHOOK_QUEUE_URL ?? "";
  const failures: { itemIdentifier: string }[] = [];
  let partners: Partner[] | undefined;
  const now = new Date();

  for (const record of event.Records) {
    try {
      const oldImage = image(record, "OldImage");
      const newImage = image(record, "NewImage");
      const type = eventFor(oldImage, newImage);
      if (!type || !newImage) continue;
      partners ??= await subscribedPartners(table);
      const interested = partners.filter((p) => partnerScope(newImage, p, now).eligible);
      if (interested.length === 0) continue;
      const contentId = String(newImage["id"]);
      const updatedAt = String(newImage["withdrawnAt"] ?? syndicationUpdatedAtOf(newImage) ?? now.toISOString());
      const entries = interested.map((p) => {
        const delivery: QueuedDelivery = { partnerId: p.id, eventId: randomUUID(), type, contentId, updatedAt };
        return { Id: delivery.eventId.replace(/-/g, "").slice(0, 80), MessageBody: JSON.stringify(delivery) };
      });
      for (let i = 0; i < entries.length; i += 10) {
        await getSqs().send(new SendMessageBatchCommand({ QueueUrl: queueUrl, Entries: entries.slice(i, i + 10) }));
      }
      console.log(`partner-events: ${type} ${contentId} → ${interested.map((p) => p.id).join(", ")}`);
    } catch (err) {
      console.error("partner-events: record failed", err);
      if (record.dynamodb?.SequenceNumber) failures.push({ itemIdentifier: record.dynamodb.SequenceNumber });
    }
  }
  return { batchItemFailures: failures };
};
