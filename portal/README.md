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
npm run test -w @niltv/portal       # vitest: time zones, .ics, nav, router, heatmap, message merging
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
Sessions live in `sessionStorage` (survive a reload, not a browser restart).

## Hosting

- It is a single-page app with real paths (`/messages/{id}`, `/schedule/{id}`,
  `/postings/{id}`). The host must answer every path with `index.html`
  (CloudFront: a 403/404 custom error response to `/index.html` with 200).
- `index.html` carries `noindex, nofollow` and `public/robots.txt` disallows all.
- Fonts load from Google Fonts, like niltv.com.

## Polling

The inbox refreshes every 20 s and `GET /v1/me` every 60 s; TanStack Query
pauses both while the tab is hidden. An open thread polls
`?after={lastId}` every 5 s while visible and re-reads the newest page once a
minute so hide and unhide reach other viewers. The read marker moves when a
thread is open and the tab is visible.

## Content Hub

Asks and claims are a static preview from the approved mockup. Nothing on that
screen calls the API and every action is disabled.
