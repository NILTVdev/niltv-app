/**
 * Expo push delivery (design §6.4, §7): audience resolution off the GSI1
 * topic partitions, 100-message chunks to the Expo Push API, and
 * receipt-based pruning of dead tokens. The NotifFollow/device GSI rows ARE
 * the topic system — no SNS topics; switching providers later swaps only
 * this module.
 */
import { BatchGetCommand, BatchWriteCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import {
  DEVICES_ALL_GSI1PK,
  GSI1,
  VOTE_SK_PREFIX,
  getDocClient,
  notifTargetGsi1Pk,
  userKey,
} from "./db";
import type { Item } from "./shape";

export interface PushNotification {
  title: string;
  body: string;
  /** lands in the notification payload — the client deep-links off data.url */
  data?: Record<string, unknown>;
}

/** A deliverable device: the owner plus the Expo token to address. */
export interface PushDevice {
  userId: string;
  expoPushToken: string;
}

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
const EXPO_RECEIPTS_URL = "https://exp.host/--/api/v2/push/getReceipts";
/** Expo's documented max messages per POST /push/send call. */
const EXPO_CHUNK_SIZE = 100;
/** DynamoDB BatchGetItem / BatchWriteItem limits. */
const BATCH_GET_SIZE = 100;
const BATCH_WRITE_SIZE = 25;

const chunk = <T>(items: readonly T[], size: number): T[][] => {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
};

const table = (): string => process.env.TABLE_NAME ?? "";

/** Query a full GSI1 partition, paginated. */
async function queryGsi1Partition(pk: string, skPrefix?: string): Promise<Item[]> {
  const db = getDocClient();
  const rows: Item[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await db.send(
      new QueryCommand({
        TableName: table(),
        IndexName: GSI1,
        KeyConditionExpression: skPrefix
          ? "GSI1PK = :pk AND begins_with(GSI1SK, :sk)"
          : "GSI1PK = :pk",
        ExpressionAttributeValues: { ":pk": pk, ...(skPrefix ? { ":sk": skPrefix } : {}) },
        ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      }),
    );
    rows.push(...((page.Items ?? []) as Item[]));
    exclusiveStartKey = page.LastEvaluatedKey;
  } while (exclusiveStartKey);
  return rows;
}

/** userIds opted into one ★-picker target (design §6.4: GSI1 TARGET#{type}#{id}). */
export async function listTargetUserIds(targetType: string, targetId: string): Promise<string[]> {
  const rows = await queryGsi1Partition(notifTargetGsi1Pk(targetType, targetId));
  return rows
    .map((r) => String(r["GSI1SK"] ?? ""))
    .filter((sk) => sk.startsWith("USER#"))
    .map((sk) => sk.slice("USER#".length));
}

/**
 * userIds who cast a vote in an event, from the GSI1 vote mirror (design §7:
 * the "results" push audience). Anonymized rows (deleted accounts) are
 * excluded — they have no devices anyway.
 */
export async function listVoterUserIds(eventId: string): Promise<string[]> {
  const rows = await queryGsi1Partition(`EVENT#${eventId}`, VOTE_SK_PREFIX);
  return rows
    .map((r) => String(r["PK"] ?? ""))
    .filter((pk) => pk.startsWith("USER#") && !pk.startsWith("USER#deleted#"))
    .map((pk) => pk.slice("USER#".length));
}

/** Every registered device row from the DEVICES#ALL broadcast partition. */
async function listAllDeviceRows(): Promise<Item[]> {
  return queryGsi1Partition(DEVICES_ALL_GSI1PK);
}

const toDevice = (row: Item): PushDevice => ({
  userId: String(row["PK"] ?? "").slice("USER#".length),
  expoPushToken: String(row["SK"] ?? "").slice("DEVICE#".length),
});

/**
 * Keep only devices whose owner still has the global push toggle on
 * (design §7: user.pushEnabled checked at fanout, not at registration).
 */
async function filterPushEnabled(devices: PushDevice[]): Promise<PushDevice[]> {
  const userIds = [...new Set(devices.map((d) => d.userId))];
  if (userIds.length === 0) return [];
  const db = getDocClient();
  const enabled = new Set<string>();
  for (const ids of chunk(userIds, BATCH_GET_SIZE)) {
    const { Responses } = await db.send(
      new BatchGetCommand({
        RequestItems: {
          [table()]: {
            Keys: ids.map((id) => userKey(id)),
            ProjectionExpression: "PK, pushEnabled",
          },
        },
      }),
    );
    for (const row of Responses?.[table()] ?? []) {
      if (row["pushEnabled"] === true) enabled.add(String(row["PK"]).slice("USER#".length));
    }
  }
  return devices.filter((d) => enabled.has(d.userId));
}

/** Deliverable devices for a set of users (dedup across target sets happens in the caller's Set). */
export async function devicesForUsers(userIds: ReadonlySet<string>): Promise<PushDevice[]> {
  if (userIds.size === 0) return [];
  const all = await listAllDeviceRows();
  return filterPushEnabled(all.map(toDevice).filter((d) => userIds.has(d.userId)));
}

/** Every deliverable device — the broadcast audience (design §7 voting open/closing pushes). */
export async function allDevices(): Promise<PushDevice[]> {
  const all = await listAllDeviceRows();
  return filterPushEnabled(all.map(toDevice));
}

interface ExpoTicket {
  status: "ok" | "error";
  id?: string;
  message?: string;
  details?: { error?: string };
}

/** POST one chunk to the Expo push API; returns the tickets (throws on transport failure). */
async function postExpoChunk(
  devices: PushDevice[],
  notification: PushNotification,
): Promise<ExpoTicket[]> {
  const res = await fetch(EXPO_PUSH_URL, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(
      devices.map((d) => ({
        to: d.expoPushToken,
        title: notification.title,
        body: notification.body,
        sound: "default",
        ...(notification.data ? { data: notification.data } : {}),
      })),
    ),
  });
  if (!res.ok) throw new Error(`Expo push send failed: HTTP ${res.status}`);
  const payload = (await res.json()) as { data?: ExpoTicket[] };
  return payload.data ?? [];
}

/**
 * Best-effort receipt check (design §6.4 receipt-based pruning): most
 * DeviceNotRegistered receipts are available immediately after send; ones
 * that are not are caught by the NEXT send's tickets, so one poll is enough.
 * Returns ticket ids whose receipt says the device is gone.
 */
async function fetchDeadReceiptIds(ticketIds: string[]): Promise<Set<string>> {
  const dead = new Set<string>();
  for (const ids of chunk(ticketIds, 300)) {
    const res = await fetch(EXPO_RECEIPTS_URL, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ ids }),
    });
    if (!res.ok) continue; // best-effort — the next send prunes instead
    const payload = (await res.json()) as {
      data?: Record<string, { status: string; details?: { error?: string } }>;
    };
    for (const [id, receipt] of Object.entries(payload.data ?? {})) {
      if (receipt.details?.error === "DeviceNotRegistered") dead.add(id);
    }
  }
  return dead;
}

/** Delete dead device rows (their GSI mirror disappears with them). */
async function pruneDevices(devices: PushDevice[]): Promise<void> {
  if (devices.length === 0) return;
  const db = getDocClient();
  for (const batch of chunk(devices, BATCH_WRITE_SIZE)) {
    await db.send(
      new BatchWriteCommand({
        RequestItems: {
          [table()]: batch.map((d) => ({
            DeleteRequest: {
              Key: { PK: `USER#${d.userId}`, SK: `DEVICE#${d.expoPushToken}` },
            },
          })),
        },
      }),
    );
  }
}

export interface SendResult {
  sent: number;
  pruned: number;
}

/**
 * Send one notification to a device list: chunked send, then prune every
 * token Expo reports as DeviceNotRegistered (ticket-level immediately,
 * receipt-level via one best-effort poll).
 */
export async function sendPush(
  devices: PushDevice[],
  notification: PushNotification,
): Promise<SendResult> {
  if (devices.length === 0) return { sent: 0, pruned: 0 };

  const deadDevices: PushDevice[] = [];
  const pendingReceipts: Array<{ ticketId: string; device: PushDevice }> = [];

  for (const batch of chunk(devices, EXPO_CHUNK_SIZE)) {
    const tickets = await postExpoChunk(batch, notification);
    tickets.forEach((ticket, i) => {
      const device = batch[i];
      if (!device) return;
      if (ticket.status === "error") {
        if (ticket.details?.error === "DeviceNotRegistered") deadDevices.push(device);
      } else if (ticket.id) {
        pendingReceipts.push({ ticketId: ticket.id, device });
      }
    });
  }

  try {
    const deadIds = await fetchDeadReceiptIds(pendingReceipts.map((p) => p.ticketId));
    deadDevices.push(...pendingReceipts.filter((p) => deadIds.has(p.ticketId)).map((p) => p.device));
  } catch (err) {
    console.error("Expo receipt poll failed (pruning deferred to next send)", err);
  }

  await pruneDevices(deadDevices);
  return { sent: devices.length - deadDevices.length, pruned: deadDevices.length };
}

/** Resolve a user set to devices and send (the §6.4 fanout tail). */
export async function pushToUsers(
  userIds: ReadonlySet<string>,
  notification: PushNotification,
): Promise<SendResult> {
  return sendPush(await devicesForUsers(userIds), notification);
}

/** Send to every opted-in device (design §7 broadcast rows). */
export async function broadcastPush(notification: PushNotification): Promise<SendResult> {
  return sendPush(await allDevices(), notification);
}
