/*
 * NIL TV Portal service worker: web push only. No fetch handler and no
 * caching, so every request goes to the network exactly as before.
 *
 * The app registers it only while the admin push switch is on and the stage
 * has a VAPID key. Payload (JSON): { title, body, url, tag, badge?, at }.
 * Every push shows a notification, even one that cannot be read: iPhone
 * and iPad take the permission away from web apps that push silently.
 */

const ICON = "/icon-192.png";
const BADGE = "/badge-72.png";
const FALLBACK_TITLE = "NIL TV Portal";
const FALLBACK_BODY = "Something new in the portal.";

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

function readPayload(event) {
  if (!event.data) return {};
  try {
    const data = event.data.json();
    return data && typeof data === "object" ? data : {};
  } catch {
    return { body: event.data.text() };
  }
}

/** A number sets the count on the app icon; anything else shows a dot. */
async function setBadge(count) {
  try {
    if (!("setAppBadge" in self.navigator)) return;
    if (typeof count === "number" && Number.isFinite(count) && count >= 0) await self.navigator.setAppBadge(count);
    else await self.navigator.setAppBadge();
  } catch {
    /* no badge on this platform */
  }
}

async function show(event) {
  const data = readPayload(event);
  const titled = typeof data.title === "string" && data.title !== "";
  const body = typeof data.body === "string" ? data.body : "";
  const title = titled ? data.title : FALLBACK_TITLE;
  const options = {
    // Previews off sends a title alone; only an unreadable push gets the stock line.
    body: titled || body ? body : FALLBACK_BODY,
    icon: ICON,
    badge: BADGE,
    data: { url: typeof data.url === "string" && data.url.startsWith("/") ? data.url : "/" },
  };
  if (typeof data.tag === "string" && data.tag) {
    options.tag = data.tag;
    // A newer message in the same thread replaces the old one and still alerts.
    options.renotify = true;
  }
  const at = typeof data.at === "string" ? Date.parse(data.at) : NaN;
  if (Number.isFinite(at)) options.timestamp = at;

  const badge = setBadge(data.badge);
  try {
    await self.registration.showNotification(title, options);
  } catch {
    // Options this browser refuses: show the plain version, never nothing.
    await self.registration.showNotification(title, { body: options.body, data: options.data });
  }
  await badge;
}

self.addEventListener("push", (event) => {
  event.waitUntil(show(event));
});

/** Same-origin only: anything else opens the portal home instead. */
function targetUrl(raw) {
  const home = new URL("/", self.location.origin);
  if (typeof raw !== "string") return home;
  try {
    const url = new URL(raw, self.location.origin);
    return url.origin === self.location.origin ? url : home;
  } catch {
    return home;
  }
}

async function open(url) {
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  const portal = windows.find((c) => {
    try {
      return new URL(c.url).origin === self.location.origin;
    } catch {
      return false;
    }
  });
  if (!portal) {
    await self.clients.openWindow(url.href);
    return;
  }
  await portal.focus().catch(() => undefined);
  if (portal.url === url.href) return;
  try {
    await portal.navigate(url.href);
  } catch {
    // A window this worker does not control yet: the app moves itself.
    portal.postMessage({ type: "portal:navigate", url: url.pathname + url.search + url.hash });
  }
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  event.waitUntil(open(targetUrl(data.url)));
});
