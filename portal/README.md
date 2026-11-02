# @niltv/portal: NIL TV Portal

The signed-in workspace for athletes, guests and staff, served at portal.niltv.com.
Vite, React 19, TanStack Query, no UI library. It talks to the portal HTTP API
(`backend/lib/portal-stack.ts`) with the Cognito ID token of a niltv.com account.
Every request and response shape comes from `types/src/portal.ts`.

## Run

```sh
# from the repo root (workspaces)
npm run dev -w @niltv/portal        # http://localhost:5190
npm run typecheck -w @niltv/portal
npm run test -w @niltv/portal       # vitest: time zones, .ics, nav, router, heatmap, messages, mentions, push
npm run build -w @niltv/portal      # static files in portal/dist
```

Create `portal/.env.local` from `.env.example` first (gitignored):

| Variable | What |
|---|---|
| `VITE_PORTAL_API` | the `PortalApiUrl` output of the portal stack, no trailing slash |
| `VITE_COGNITO_POOL_ID` | the niltv.com user pool |
| `VITE_COGNITO_CLIENT_ID` | an app client the portal API's JWT authorizer accepts |
| `VITE_STAGE` | `dev` or `prod`; anything but `prod` shows a stage badge |

Without the first three the app renders a setup screen and sends nothing.
Port 5190 is fixed (`strictPort`): it is the localhost origin the dev stack's CORS allows.

## Access

Any niltv.com account can sign in. The API decides who gets in: an account
without an active portal row gets 403 `NOT_MEMBER` and sees the no-access
screen. The menu and the route guard read `PORTAL_PERMISSIONS` through
`portalCan`, the same table the server checks. A 401 signs the tab out.
In a browser tab the session lives in `sessionStorage` (survives a reload, not a
browser restart). Opened as the installed app from the Home Screen, it lives in
`localStorage`, so closing the app does not sign people out. Sign-out clears both.

## Hosting

- It is a single-page app with real paths (`/messages/{id}`, `/schedule/{id}`,
  `/postings/{id}`). The host must answer every path with `index.html`
  (CloudFront: a 403/404 custom error response to `/index.html` with 200).
- `index.html` carries `noindex, nofollow` and `public/robots.txt` disallows all.
- Fonts load from Google Fonts, like niltv.com.
- `public/sw.js` and `public/manifest.webmanifest` must be served as files at
  the root (the SPA rewrite skips `.js` and `.webmanifest`).

## Brand

Styled to the NIL TV brand kit (Google Drive, CONTENT MASTER > NIL TV BRAND
KIT, and its `NILTV_Brand_Guidelines.pdf`). The rules the CSS follows are at the
top of `src/styles.css`. In short:

- The logo is always the image (`public/brand/niltv-logo.webp`, from the kit's
  `00_Logos/niltv-logo-gold-transparent.png`), never typed, at least 40px tall.
  `src/ui/Brand.tsx` is the one place it renders.
- Black `#060608`, gold `#D3B368` with black text on it, white and muted
  `#A1A1AA` text. The metallic gradient is only on the logo and the sign-in
  slash. Live red `#C42420` is for LIVE and NEW tags only.
- Barlow Condensed in caps for headlines, Montserrat in caps with wide
  spacing for tags and labels, Inter for body copy and buttons.
- Tags lean 12°; buttons are pills; cards are rounded.
- The favicon and app icons are the kit logo, made at the sizes in
  `public/` (logo on transparent for the favicon, on black for app icons).

## Polling

The inbox refreshes every 20 s and `GET /v1/me` every 60 s; TanStack Query
pauses both while the tab is hidden. An open thread polls
`?after={lastId}` every 5 s while visible and re-reads the newest page once a
minute so hide and unhide reach other viewers. The read marker moves when a
thread is open and the tab is visible.

## Notifications

Quietest first: the badge in the portal for everything, a phone or browser
notification (web push) for what is addressed to you, and one summary email
for what is still unseen an hour later. Each member picks a cadence per topic
in Account. Two admin switches in Settings (`activityEmails`, `webPush`) let
anything out of the portal; both are off while testing.

- The unread count shows in the tab title and on the installed app's icon.
- `public/sw.js` handles push only: no fetch handler, no caching. The app
  registers it only when `GET /v1/me` says `notifications.webPush` is on and
  carries a `vapidPublicKey`. Until then nothing asks for permission.
- The permission prompt never shows on first load or sign-in. Athletes and
  guests see a small card in a desk thread after writing there; staff when
  they open one. "Not now" holds for 30 days (localStorage).
- iPhone and iPad only get push once the portal is on the Home Screen. The
  manifest (`display: standalone`) and icons in `public/` make that work.
  The icons are generated from `mobile/assets/images/icon.png`.

## Content Hub

Asks and claims are a static preview from the approved mockup. Nothing on that
screen calls the API and every action is disabled.
