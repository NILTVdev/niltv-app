/**
 * Web push for the portal: browsers subscribe (POST /v1/push), the notifier
 * sends. The VAPID key pair lives in SSM (public key as a String, private
 * key as a SecureString; backend/scripts/portal-vapid.ts creates them).
 * With no keys, push is simply not set up: the API reports no public key
 * and the notifier sends nothing.
 *
 * Payloads are encrypted for the browser (RFC 8291), so the push service
 * never sees the text. Endpoints are checked against the known push
 * services both when saved and before every send.
 */
import { createHash } from "node:crypto";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { DeleteCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { type PushDevice, type PushSubscribeRequest, isPushServiceUrl } from "@niltv/types";
import webpush from "web-push";
import { PUSH_DEVICE_SK_PREFIX, getDocClient, pushDeviceKey } from "../db";

const table = (): string => process.env.TABLE_NAME ?? "";

/** Oldest devices beyond this are dropped when a new one subscribes. */
export const MAX_DEVICES = 10;
/** How long a push service holds an undelivered notification. */
const PUSH_TTL_SECONDS = 24 * 60 * 60;

export interface PushPayload {
  title: string;
  body: string;
  /** a path in the portal, opened on tap */
  url: string;
  /** one notification per tag: a newer one replaces it */
  tag: string;
  /** app icon badge; absent = a dot */
  badge?: number;
  at: string;
}

/* ── VAPID keys (SSM, cached per container) ────────────────────────────────── */

interface Vapid {
  publicKey: string;
  privateKey: string;
}

const MISSING_RETRY_MS = 5 * 60 * 1000;
let ssm: SSMClient | undefined;
const cache = new Map<string, { value: string | undefined; at: number }>();

async function param(name: string | undefined, decrypt: boolean): Promise<string | undefined> {
  if (!name) return undefined;
  const hit = cache.get(name);
  if (hit && (hit.value !== undefined || Date.now() - hit.at < MISSING_RETRY_MS)) return hit.value;
  let value: string | undefined;
  try {
    const out = await (ssm ??= new SSMClient({})).send(new GetParameterCommand({ Name: name, WithDecryption: decrypt }));
    value = out.Parameter?.Value || undefined;
  } catch (err) {
    if ((err as { name?: string }).name !== "ParameterNotFound") throw err;
  }
  cache.set(name, { value, at: Date.now() });
  return value;
}

export const vapidPublicKey = (): Promise<string | undefined> => param(process.env.VAPID_PUBLIC_PARAM, false);

async function vapid(): Promise<Vapid | undefined> {
  const [publicKey, privateKey] = await Promise.all([
    vapidPublicKey(),
    param(process.env.VAPID_PRIVATE_PARAM, true),
  ]);
  return publicKey && privateKey ? { publicKey, privateKey } : undefined;
}

/* ── Devices (USER#{sub} / PUSH#{id}) ──────────────────────────────────────── */

export interface StoredDevice extends PushDevice {
  endpoint: string;
  p256dh: string;
  authSecret: string;
}

export const deviceId = (endpoint: string): string => createHash("sha256").update(endpoint).digest("hex").slice(0, 32);

function parseDevice(item: Record<string, unknown>): StoredDevice | undefined {
  const s = (k: string): string | undefined => (typeof item[k] === "string" ? (item[k] as string) : undefined);
  const id = s("id");
  const endpoint = s("endpoint");
  const p256dh = s("p256dh");
  const authSecret = s("authSecret");
  if (!id || !endpoint || !p256dh || !authSecret) return undefined;
  return {
    id,
    endpoint,
    p256dh,
    authSecret,
    label: s("label") ?? "Browser",
    createdAt: s("createdAt") ?? new Date(0).toISOString(),
    ...(s("lastSentAt") ? { lastSentAt: s("lastSentAt")! } : {}),
  };
}

export const publicDevice = (d: StoredDevice): PushDevice => ({
  id: d.id,
  label: d.label,
  createdAt: d.createdAt,
  ...(d.lastSentAt ? { lastSentAt: d.lastSentAt } : {}),
});

export async function listDevices(sub: string): Promise<StoredDevice[]> {
  const out = await getDocClient().send(
    new QueryCommand({
      TableName: table(),
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
      ExpressionAttributeValues: { ":pk": `USER#${sub}`, ":prefix": PUSH_DEVICE_SK_PREFIX },
    }),
  );
  return (out.Items ?? [])
    .map(parseDevice)
    .filter((d): d is StoredDevice => d !== undefined)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** Save (or refresh) this browser's subscription. Resubscribing keeps the original date. */
export async function saveDevice(sub: string, req: PushSubscribeRequest, label: string): Promise<PushDevice> {
  const id = deviceId(req.endpoint);
  const existing = await listDevices(sub);
  const same = existing.find((d) => d.id === id);
  const device: StoredDevice = {
    id,
    endpoint: req.endpoint,
    p256dh: req.keys.p256dh,
    authSecret: req.keys.auth,
    label,
    createdAt: same?.createdAt ?? new Date().toISOString(),
    ...(same?.lastSentAt ? { lastSentAt: same.lastSentAt } : {}),
  };
  await getDocClient().send(new PutCommand({ TableName: table(), Item: { ...pushDeviceKey(sub, id), ...device } }));
  const others = existing.filter((d) => d.id !== id);
  for (const old of others.slice(0, Math.max(0, others.length + 1 - MAX_DEVICES))) await removeDevice(sub, old.id);
  return publicDevice(device);
}

export async function removeDevice(sub: string, id: string): Promise<boolean> {
  const out = await getDocClient().send(
    new DeleteCommand({ TableName: table(), Key: pushDeviceKey(sub, id), ReturnValues: "ALL_OLD" }),
  );
  return out.Attributes !== undefined;
}

/* ── Sending ───────────────────────────────────────────────────────────────── */

/** Push-service Topic header: one undelivered notice per tag waits, newer replaces older. */
const topicHeader = (tag: string): string => createHash("sha256").update(tag).digest("hex").slice(0, 32);

/** Send to every device the member has (pass `devices` when already read). Returns how many took it. */
export async function pushTo(sub: string, payload: PushPayload, devices?: StoredDevice[]): Promise<number> {
  const keys = await vapid();
  if (!keys) return 0;
  devices ??= await listDevices(sub);
  let delivered = 0;
  for (const device of devices) {
    if (!isPushServiceUrl(device.endpoint)) {
      await removeDevice(sub, device.id);
      continue;
    }
    try {
      await webpush.sendNotification(
        { endpoint: device.endpoint, keys: { p256dh: device.p256dh, auth: device.authSecret } },
        JSON.stringify(payload),
        {
          vapidDetails: { subject: "mailto:portal@niltv.com", publicKey: keys.publicKey, privateKey: keys.privateKey },
          TTL: PUSH_TTL_SECONDS,
          topic: topicHeader(payload.tag),
          urgency: "normal",
          timeout: 10_000,
        },
      );
      delivered++;
      await getDocClient().send(
        new UpdateCommand({
          TableName: table(),
          Key: pushDeviceKey(sub, device.id),
          UpdateExpression: "SET lastSentAt = :at",
          ConditionExpression: "attribute_exists(PK)",
          ExpressionAttributeValues: { ":at": new Date().toISOString() },
        }),
      ).catch(() => undefined);
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      // 404 and 410: the browser dropped this subscription for good.
      if (status === 404 || status === 410) await removeDevice(sub, device.id);
      else console.warn("portal: push failed", { status, device: device.id });
    }
  }
  return delivered;
}
