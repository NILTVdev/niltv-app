# @niltv/admin — staff admin tool

Internal single-page tool for staff: content CRUD + video upload/publish, and athlete
profile CRUD. Vite/React/TS, no UI library. Talks to the admin HTTP API (JWT Bearer,
`staff` Cognito group required on every route).

## Run

```sh
# from the repo root (workspaces)
npm run dev -w @niltv/admin        # http://localhost:5180
```

Create `admin/.env.local` first (gitignored):

```ini
# the AdminApiUrl output of the deployed api stack, e.g. https://xxxx.execute-api.us-east-1.amazonaws.com
VITE_ADMIN_API_BASE=<AdminApiUrl stack output>

# optional; defaults to the client id in src/config.ts (public identifier, not a secret)
# VITE_COGNITO_CLIENT_ID=<app client id>
```

Without `VITE_ADMIN_API_BASE` the app renders a setup screen instead of making requests.
The admin API's CORS must allow `http://localhost:5180` (it does in the dev stack).

## Staff access

Sign-in is Cognito SRP (email/password) against the user pool and client set in
`src/config.ts`. Any Cognito user can authenticate, but every API route requires
membership in the `staff` group; non-staff accounts get "This account is not in the
staff group." A maintainer provisions staff access.

Sessions live in `sessionStorage` (survive a reload, not a browser restart).

## Content workflow

1. **Create** the row (title, description, channel, athlete, rights checkbox).
2. Open the row (**Manage**) → pick a video file → **Upload** — the app requests a
   presigned S3 PUT, uploads with a progress bar, then polls
   `GET /admin/content/{id}/status` every 5s (`uploading → processing → ready`,
   or `failed` with the transcode error shown).
3. Tick **Rights confirmed** if not done at create time.
4. **Publish** — enabled only when status is `ready` *and* rights are confirmed;
   a server 409 (NOT_READY) surfaces its message. Published rows offer **Unpublish**.

## Checks

```sh
npm run typecheck -w @niltv/admin
npm run build     -w @niltv/admin
```
