/**
 * Web push in the browser: what this device can do, the service worker,
 * this browser's subscription and the label it shows under in Account.
 *
 * The pure helpers take their inputs as arguments so they are unit tested.
 * The rest touch navigator and window, and the app only calls them when
 * the admin push switch is on and the stage has a VAPID key: until then no
 * worker is registered and nothing asks for permission.
 */
import { isPushServiceUrl, type PushSubscribeRequest } from "@niltv/types";

/* ── Pure helpers ──────────────────────────────────────────────────────── */

/**
 * supported        the browser can subscribe
 * ios-home-screen  iPhone or iPad in a browser tab: push only works once the
 *                  portal is added to the Home Screen and opened from there
 * unsupported      no service worker, PushManager or Notification
 */
export type PushSupport = "supported" | "ios-home-screen" | "unsupported";

export interface PushEnv {
  serviceWorker: boolean;
  pushManager: boolean;
  notification: boolean;
  ios: boolean;
  standalone: boolean;
}

export function pushSupport(env: PushEnv): PushSupport {
  if (env.ios && !env.standalone) return "ios-home-screen";
  return env.serviceWorker && env.pushManager && env.notification ? "supported" : "unsupported";
}

/** iPhone, iPad or iPod. iPad Safari reports a Mac, so a Mac with a touch screen counts. */
export const isIos = (ua: string, maxTouchPoints = 0): boolean =>
  /iPhone|iPad|iPod/i.test(ua) || (/Macintosh/i.test(ua) && maxTouchPoints > 1);

/** Opened as an installed app (Home Screen, dock, app window), not in a browser tab. */
export const isStandaloneWith = (displayModeStandalone: boolean, navigatorStandalone: boolean | undefined): boolean =>
  displayModeStandalone || navigatorStandalone === true;

/** How a device reads in Account: "iPhone", "Chrome on Mac", "Edge on Windows". */
export function deviceLabel(ua: string, maxTouchPoints = 0): string {
  if (/iPhone|iPod/i.test(ua)) return "iPhone";
  if (/iPad/i.test(ua) || (/Macintosh/i.test(ua) && maxTouchPoints > 1)) return "iPad";
  const os = /Android/i.test(ua)
    ? "Android"
    : /Windows/i.test(ua)
      ? "Windows"
      : /Macintosh|Mac OS X/i.test(ua)
        ? "Mac"
        : /CrOS/i.test(ua)
          ? "Chromebook"
          : /Linux/i.test(ua)
            ? "Linux"
            : "";
  // Order matters: Edge, Opera and Samsung Internet all say "Chrome" too, and Chrome says "Safari".
  const browser = /Edg(A|iOS)?\//i.test(ua)
    ? "Edge"
    : /SamsungBrowser\//i.test(ua)
      ? "Samsung Internet"
      : /OPR\/|Opera/i.test(ua)
        ? "Opera"
        : /Firefox\/|FxiOS/i.test(ua)
          ? "Firefox"
          : /Chrome\/|CriOS|Chromium/i.test(ua)
            ? "Chrome"
            : /Safari\//i.test(ua)
              ? "Safari"
              : "";
  if (browser && os) return `${browser} on ${os}`;
  return browser || os || "Web browser";
}

/** A base64url string (the VAPID public key) as bytes for PushManager.subscribe. */
export function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const b64 = value.trim().replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  const raw = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** Bytes as unpadded base64url, the way PushSubscription.toJSON() writes keys. */
export function bytesToBase64Url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let raw = "";
  for (const b of view) raw += String.fromCharCode(b);
  return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** True when a subscription was made with this key (a rotated key needs a new one). */
export function sameKey(current: ArrayBuffer | null | undefined, key: Uint8Array): boolean {
  if (!current) return false;
  const a = new Uint8Array(current);
  return a.length === key.length && a.every((b, i) => b === key[i]);
}

/** A same-origin path from a notification's url, else null (anything off-site is refused). */
export function portalPath(url: string, origin: string): string | null {
  try {
    const target = new URL(url, origin);
    if (target.origin !== origin) return null;
    return target.pathname + target.search + target.hash;
  } catch {
    return null;
  }
}

/** "Not now" on the notification prompt holds for 30 days. */
export const PROMPT_SNOOZE_MS = 30 * 24 * 60 * 60 * 1000;

/** A stored snooze is a time in ms; missing or unreadable values do not snooze. */
export function isSnoozed(stored: string | null | undefined, now: number): boolean {
  if (!stored) return false;
  const until = Number(stored);
  return Number.isFinite(until) && until > now;
}

export const snoozeValue = (now: number): string => String(now + PROMPT_SNOOZE_MS);

/** The POST /v1/push body for a subscription. Keys come from toJSON(), else getKey(). */
export function subscriptionBody(
  sub: { endpoint: string; toJSON?: () => { keys?: Record<string, string> }; getKey?: (name: PushEncryptionKeyName) => ArrayBuffer | null },
  label: string,
): PushSubscribeRequest | null {
  const json = sub.toJSON?.().keys ?? {};
  const p256dh = json["p256dh"] ?? encodeKey(sub.getKey?.("p256dh"));
  const auth = json["auth"] ?? encodeKey(sub.getKey?.("auth"));
  if (!p256dh || !auth || !isPushServiceUrl(sub.endpoint)) return null;
  return { endpoint: sub.endpoint, keys: { p256dh, auth }, label: label.slice(0, 60) };
}

const encodeKey = (key: ArrayBuffer | null | undefined): string | undefined => (key ? bytesToBase64Url(key) : undefined);

/* ── Browser ───────────────────────────────────────────────────────────── */

const SW_URL = "/sw.js";
const SNOOZE_KEY = "niltv-portal:push-prompt-until";
const DEVICE_KEY = "niltv-portal:push-device";
const SYNCED_KEY = "niltv-portal:push-synced";

function read(store: () => Storage, key: string): string | null {
  try {
    return store().getItem(key);
  } catch {
    return null;
  }
}

function write(store: () => Storage, key: string, value: string | null): void {
  try {
    if (value === null) store().removeItem(key);
    else store().setItem(key, value);
  } catch {
    /* storage blocked: the in-memory copy still holds for this visit */
  }
}

const local = () => window.localStorage;
const session = () => window.sessionStorage;

export function runningStandalone(): boolean {
  try {
    const nav = navigator as Navigator & { standalone?: boolean };
    return isStandaloneWith(window.matchMedia?.("(display-mode: standalone)").matches ?? false, nav.standalone);
  } catch {
    return false;
  }
}

export function browserSupport(): PushSupport {
  return pushSupport({
    serviceWorker: "serviceWorker" in navigator,
    pushManager: "PushManager" in window,
    notification: "Notification" in window,
    ios: isIos(navigator.userAgent, navigator.maxTouchPoints ?? 0),
    standalone: runningStandalone(),
  });
}

export const thisDeviceLabel = (): string => deviceLabel(navigator.userAgent, navigator.maxTouchPoints ?? 0);

export function notificationPermission(): NotificationPermission | undefined {
  try {
    return "Notification" in window ? Notification.permission : undefined;
  } catch {
    return undefined;
  }
}

/** Register the worker (a no-op when it already is) and wait until it is active. */
export async function workerRegistration(): Promise<ServiceWorkerRegistration> {
  await navigator.serviceWorker.register(SW_URL, { scope: "/" });
  return navigator.serviceWorker.ready;
}

export async function currentSubscription(): Promise<PushSubscription | null> {
  const reg = await navigator.serviceWorker.getRegistration("/");
  return reg ? reg.pushManager.getSubscription() : null;
}

/** Subscribe with the stage's key. A subscription made with an older key is replaced. */
export async function subscribeBrowser(vapidKey: string): Promise<PushSubscription> {
  const key = base64UrlToBytes(vapidKey);
  const reg = await workerRegistration();
  const existing = await reg.pushManager.getSubscription();
  if (existing) {
    // A browser that does not report the key keeps its subscription.
    const used = existing.options?.applicationServerKey;
    if (!used || sameKey(used, key)) return existing;
    await existing.unsubscribe().catch(() => false);
  }
  return reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
}

/** Drop this browser's subscription. Resolves to its endpoint, for POST /v1/push/remove. */
export async function unsubscribeBrowser(): Promise<string | undefined> {
  const sub = await currentSubscription();
  if (!sub) return undefined;
  const { endpoint } = sub;
  await sub.unsubscribe().catch(() => false);
  return endpoint;
}

/** The device id POST /v1/push returned for this browser, so Account can mark it. */
let deviceId: string | null | undefined;
export function thisDeviceId(): string | null {
  if (deviceId === undefined) deviceId = read(local, DEVICE_KEY);
  return deviceId;
}
export function rememberDevice(id: string | null): void {
  deviceId = id;
  write(local, DEVICE_KEY, id);
}

let snoozedNow = false;
export const promptSnoozed = (now: number = Date.now()): boolean => snoozedNow || isSnoozed(read(local, SNOOZE_KEY), now);
export function snoozePrompt(now: number = Date.now()): void {
  snoozedNow = true;
  write(local, SNOOZE_KEY, snoozeValue(now));
}

let synced = false;

/**
 * Once per session, when permission is granted and a subscription exists:
 * send it again so the server keeps the endpoint and keys it holds current.
 * A subscription made with an older key is replaced first. Quiet: errors
 * are dropped and the next session tries again.
 */
export async function resyncSubscription(
  vapidKey: string,
  save: (body: PushSubscribeRequest) => Promise<{ id: string }>,
): Promise<void> {
  if (synced || read(session, SYNCED_KEY)) return;
  synced = true;
  write(session, SYNCED_KEY, "1");
  try {
    if (notificationPermission() !== "granted") return;
    if (!(await currentSubscription())) return;
    const body = subscriptionBody(await subscribeBrowser(vapidKey), thisDeviceLabel());
    if (body) rememberDevice((await save(body)).id);
  } catch {
    /* next session */
  }
}

/** The worker asks an open window to move to a notification's page. */
export function onWorkerNavigate(goTo: (path: string) => void): () => void {
  if (!("serviceWorker" in navigator)) return () => {};
  const onMessage = (e: MessageEvent) => {
    const data = e.data as { type?: unknown; url?: unknown } | null;
    if (data?.type !== "portal:navigate" || typeof data.url !== "string") return;
    const path = portalPath(data.url, window.location.origin);
    if (path) goTo(path);
  };
  navigator.serviceWorker.addEventListener("message", onMessage);
  try {
    navigator.serviceWorker.startMessages();
  } catch {
    /* delivered once the page has loaded anyway */
  }
  return () => navigator.serviceWorker.removeEventListener("message", onMessage);
}

/** The unread count on the installed app's icon, where the platform has one. */
export function showAppBadge(count: number): void {
  try {
    if (!("setAppBadge" in navigator)) return;
    const done = count > 0 ? navigator.setAppBadge(count) : navigator.clearAppBadge();
    done.catch(() => {});
  } catch {
    /* no badge here */
  }
}
