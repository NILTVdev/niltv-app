/**
 * webhook-deliver — SQS consumer that POSTs one signed lifecycle event to a
 * partner's endpoint. A non-2xx or a timeout throws, so SQS redelivers with
 * backoff; after the queue's maxReceiveCount the message parks in the
 * dead-letter queue and the alarm fires. Every attempt is logged on the
 * partner's partition (WEBHOOK# rows) so admin can show a delivery log.
 *
 * Signature: `x-niltv-signature: sha256=HMAC(secret, "{timestamp}.{body}")`
 * plus `x-niltv-timestamp`, the standard shape partners already verify for
 * other providers.
 */
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { PartnerWebhookEvent } from "@niltv/types";
import type { SQSBatchResponse, SQSEvent } from "aws-lambda";
import { getDocClient, partnerKey, webhookLogKey } from "../../lib/db";
import { webhookSignature } from "../../lib/partner-keys";
import { webhookUrlProblem } from "../../lib/webhook-url";
import type { QueuedDelivery } from "./partner-events";

const TIMEOUT_MS = 10_000;

async function deliver(delivery: QueuedDelivery, table: string): Promise<void> {
  const { Item: partner } = await getDocClient().send(
    new GetCommand({ TableName: table, Key: partnerKey(delivery.partnerId) }),
  );
  const url = partner?.["webhookUrl"];
  const secret = partner?.["webhookSecret"];
  if (!partner || partner["status"] !== "active" || partner["webhookEnabled"] !== true || typeof url !== "string") {
    console.log(`webhook-deliver: ${delivery.partnerId} no longer subscribed — dropping ${delivery.eventId}`);
    return;
  }
  if (typeof secret !== "string" || secret.length === 0) {
    throw new Error(`partner ${delivery.partnerId} has no webhook secret`);
  }
  const problem = webhookUrlProblem(url);
  if (problem) {
    // A row edited out of band. Refuse without retrying: this is not transient.
    console.error(`webhook-deliver: ${delivery.partnerId} webhook URL ${problem} — dropping ${delivery.eventId}`);
    return;
  }

  const sentAt = new Date().toISOString();
  const body = JSON.stringify(
    PartnerWebhookEvent.parse({
      eventId: delivery.eventId,
      type: delivery.type,
      contentId: delivery.contentId,
      updatedAt: delivery.updatedAt,
      sentAt,
    }),
  );
  const timestamp = String(Math.floor(Date.now() / 1000));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let status = 0;
  let error: string | undefined;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "NILTV-Webhooks/1",
        "x-niltv-timestamp": timestamp,
        "x-niltv-signature": webhookSignature(secret, timestamp, body),
        "x-niltv-event": delivery.type,
        "x-niltv-delivery": delivery.eventId,
      },
      body,
      signal: controller.signal,
    });
    status = response.status;
    if (!response.ok) error = `HTTP ${response.status}`;
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  } finally {
    clearTimeout(timer);
  }

  await getDocClient().send(
    new PutCommand({
      TableName: table,
      Item: {
        ...webhookLogKey(delivery.partnerId, sentAt, delivery.eventId),
        eventId: delivery.eventId,
        type: delivery.type,
        contentId: delivery.contentId,
        sentAt,
        status,
        ...(error ? { error } : {}),
      },
    }),
  );
  if (error) throw new Error(`webhook to ${delivery.partnerId} failed: ${error}`);
};

export const handler = async (event: SQSEvent): Promise<SQSBatchResponse> => {
  const table = process.env.TABLE_NAME ?? "";
  const failures: { itemIdentifier: string }[] = [];
  for (const record of event.Records) {
    try {
      const delivery = JSON.parse(record.body) as QueuedDelivery;
      await deliver(delivery, table);
    } catch (err) {
      console.error("webhook-deliver: attempt failed", err);
      failures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures: failures };
};
