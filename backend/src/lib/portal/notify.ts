/**
 * Portal notices: request handlers drop a small notice on an SQS queue and
 * return; the portal-notify Lambda (handlers/portal/notify.ts) resolves who
 * should hear about it and sends the email. Keeps SES out of the request
 * path and gives failed sends a retry and a dead-letter queue.
 */
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import type { HelpTopic } from "@niltv/types";

export type PortalNotice =
  | { type: "message"; convId: string; messageId: string; seq: number }
  | { type: "posting.new"; postingId: string }
  | { type: "posting.interest"; postingId: string; personSub: string }
  | { type: "posting.decision"; postingId: string; personSub: string }
  | { type: "event.new"; eventId: string }
  | { type: "event.locked"; eventId: string }
  | { type: "event.cancelled"; eventId: string }
  | { type: "request.new"; requestId: string }
  | { type: "help"; sub: string; topic: HelpTopic; message: string }
  | { type: "welcome"; sub: string };

let sqs: SQSClient | undefined;
const getSqs = (): SQSClient => (sqs ??= new SQSClient({}));

/**
 * Message notices wait a minute so someone reading the thread in the open
 * portal has seen it before an email would go out.
 */
export const MESSAGE_NOTICE_DELAY_SECONDS = 60;

export async function enqueue(notice: PortalNotice): Promise<void> {
  const url = process.env.NOTIFY_QUEUE_URL;
  if (!url) {
    console.warn("portal: NOTIFY_QUEUE_URL unset, notice dropped", notice.type);
    return;
  }
  try {
    await getSqs().send(
      new SendMessageCommand({
        QueueUrl: url,
        MessageBody: JSON.stringify(notice),
        ...(notice.type === "message" ? { DelaySeconds: MESSAGE_NOTICE_DELAY_SECONDS } : {}),
      }),
    );
  } catch (err) {
    // A lost email must never fail the request that caused it.
    console.error("portal: notice enqueue failed", notice.type, err);
  }
}
