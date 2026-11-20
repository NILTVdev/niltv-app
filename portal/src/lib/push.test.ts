import { describe, expect, it } from "vitest";
import {
  base64UrlToBytes,
  bytesToBase64Url,
  deviceLabel,
  isIos,
  isSnoozed,
  isStandaloneWith,
  portalPath,
  PROMPT_SNOOZE_MS,
  pushSupport,
  sameKey,
  snoozeValue,
  subscriptionBody,
} from "./push";

const UA = {
  chromeMac:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  safariMac:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
  iphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  edgeWindows:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0",
  firefoxWindows: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0",
  chromeAndroid:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
  samsung:
    "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36",
};

/** base64url without padding, written out here so the tests do not lean on the code under test. */
const encode = (bytes: number[]): string =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** A stand-in VAPID public key: an uncompressed P-256 point is 65 bytes starting with 0x04. */
const VAPID = encode([4, ...Array.from({ length: 64 }, (_, i) => (i * 37 + 11) % 256)]);
/** A stand-in subscription auth secret: 16 bytes. */
const AUTH = encode(Array.from({ length: 16 }, (_, i) => (i * 53 + 7) % 256));

describe("base64url keys", () => {
  it("decodes a VAPID key to the 65 bytes PushManager wants", () => {
    const bytes = base64UrlToBytes(VAPID);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBe(65);
    expect(bytes[0]).toBe(4);
  });

  it("reads url-safe characters, with or without padding", () => {
    expect([...base64UrlToBytes("AQID")]).toEqual([1, 2, 3]);
    expect([...base64UrlToBytes("-_8")]).toEqual([0xfb, 0xff]);
    expect([...base64UrlToBytes("-_8=")]).toEqual([0xfb, 0xff]);
    expect([...base64UrlToBytes(" AQID\n")]).toEqual([1, 2, 3]);
  });

  it("round-trips the way subscriptions write their keys", () => {
    expect(bytesToBase64Url(base64UrlToBytes(VAPID))).toBe(VAPID);
    expect(bytesToBase64Url(new Uint8Array([0xfb, 0xff]).buffer)).toBe("-_8");
  });

  it("knows when a subscription was made with another key", () => {
    const key = base64UrlToBytes(VAPID);
    expect(sameKey(key.slice().buffer, key)).toBe(true);
    const other = key.slice();
    other[10] = (other[10] ?? 0) ^ 1;
    expect(sameKey(other.buffer, key)).toBe(false);
    expect(sameKey(null, key)).toBe(false);
  });
});

describe("devices", () => {
  it("labels a device from its user agent", () => {
    expect(deviceLabel(UA.chromeMac)).toBe("Chrome on Mac");
    expect(deviceLabel(UA.safariMac)).toBe("Safari on Mac");
    expect(deviceLabel(UA.iphone)).toBe("iPhone");
    expect(deviceLabel(UA.edgeWindows)).toBe("Edge on Windows");
    expect(deviceLabel(UA.firefoxWindows)).toBe("Firefox on Windows");
    expect(deviceLabel(UA.chromeAndroid)).toBe("Chrome on Android");
    expect(deviceLabel(UA.samsung)).toBe("Samsung Internet on Android");
    expect(deviceLabel("")).toBe("Web browser");
  });

  it("tells an iPad that reports a Mac apart by its touch screen", () => {
    expect(deviceLabel(UA.safariMac, 5)).toBe("iPad");
    expect(isIos(UA.safariMac, 5)).toBe(true);
    expect(isIos(UA.safariMac, 0)).toBe(false);
    expect(isIos(UA.iphone)).toBe(true);
    expect(isIos(UA.chromeAndroid, 5)).toBe(false);
  });

  it("counts the installed app as standalone, a tab as not", () => {
    expect(isStandaloneWith(true, undefined)).toBe(true);
    expect(isStandaloneWith(false, true)).toBe(true);
    expect(isStandaloneWith(false, false)).toBe(false);
    expect(isStandaloneWith(false, undefined)).toBe(false);
  });

  it("sends iPhone tabs to the Home Screen first", () => {
    const all = { serviceWorker: true, pushManager: true, notification: true };
    expect(pushSupport({ ...all, ios: true, standalone: false })).toBe("ios-home-screen");
    expect(pushSupport({ ...all, ios: true, standalone: true })).toBe("supported");
    expect(pushSupport({ ...all, ios: false, standalone: false })).toBe("supported");
    expect(pushSupport({ ...all, pushManager: false, ios: false, standalone: false })).toBe("unsupported");
    expect(pushSupport({ ...all, pushManager: false, ios: true, standalone: true })).toBe("unsupported");
  });
});

describe("subscriptions", () => {
  const keys = { p256dh: VAPID, auth: AUTH };

  it("builds the POST /v1/push body from toJSON()", () => {
    const sub = { endpoint: "https://fcm.googleapis.com/fcm/send/abc123", toJSON: () => ({ keys }) };
    expect(subscriptionBody(sub, "Chrome on Mac")).toEqual({
      endpoint: "https://fcm.googleapis.com/fcm/send/abc123",
      keys,
      label: "Chrome on Mac",
    });
  });

  it("falls back to getKey() and refuses endpoints that are not a push service", () => {
    const getKey = (name: PushEncryptionKeyName) => base64UrlToBytes(name === "p256dh" ? keys.p256dh : keys.auth).buffer;
    expect(subscriptionBody({ endpoint: "https://web.push.apple.com/QOx", getKey }, "iPhone")?.keys).toEqual(keys);
    expect(subscriptionBody({ endpoint: "https://example.com/push", toJSON: () => ({ keys }) }, "x")).toBeNull();
    expect(subscriptionBody({ endpoint: "https://fcm.googleapis.com/x", toJSON: () => ({}) }, "x")).toBeNull();
  });
});

describe("notification links", () => {
  const origin = "https://portal.niltv.com";

  it("keeps portal paths", () => {
    expect(portalPath("/messages/conv-1", origin)).toBe("/messages/conv-1");
    expect(portalPath("/schedule/ev1?x=1#top", origin)).toBe("/schedule/ev1?x=1#top");
  });

  it("refuses anything off the portal", () => {
    expect(portalPath("https://example.com/messages", origin)).toBeNull();
    expect(portalPath("//example.com/messages", origin)).toBeNull();
    expect(portalPath("javascript:alert(1)", origin)).toBeNull();
  });
});

describe("prompt snooze", () => {
  const now = Date.parse("2026-10-21T12:00:00Z");

  it("holds Not now for 30 days", () => {
    const stored = snoozeValue(now);
    expect(isSnoozed(stored, now)).toBe(true);
    expect(isSnoozed(stored, now + PROMPT_SNOOZE_MS - 1)).toBe(true);
    expect(isSnoozed(stored, now + PROMPT_SNOOZE_MS)).toBe(false);
    expect(PROMPT_SNOOZE_MS).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it("does not snooze on missing or unreadable values", () => {
    expect(isSnoozed(null, now)).toBe(false);
    expect(isSnoozed(undefined, now)).toBe(false);
    expect(isSnoozed("", now)).toBe(false);
    expect(isSnoozed("soon", now)).toBe(false);
  });
});
