# Conventions

Read this before writing code in any workspace. The architecture of record is
the system design document (a maintainer document; design §-references below point there).

## Global

- **Node 22, TypeScript 5, strict.** Every workspace extends `../tsconfig.base.json`.
- **npm workspaces** — run `npm install` at the repo root only. Package names:
  `@niltv/types`, `@niltv/backend`; the Expo app is `mobile` (app name NILTV,
  bundle `com.niltv.app`).
- **API shapes live only in `@niltv/types`** (zod schemas). Lambdas parse requests and
  build responses with them; the client's API layer validates responses with them.
  Never redeclare a shape locally.
- **No secrets in the repo.** Config via env/SSM at deploy time; `.env*` is gitignored.
- Region **us-east-1**, AWS profile `default` (account `858321320457`). All stack/resource
  names prefixed `niltv-{stage}-` (stages: `dev`, `prod`).

## Backend (`backend/`)

- **aws-cdk-lib v2**, one CDK app, three stacks (design §2/§4/§5):
  - `FoundationStack` — DynamoDB single table (PK/SK + GSI1 + GSI2, streams on),
    Cognito user pool (email plus Apple and Google IdPs) with pre-signup /
    post-confirmation / pre-token-generation triggers (§6.2).
  - `ApiStack` — API Gateway **HTTP API**, JWT authorizer (Cognito), Lambda per resource
    group via `NodejsFunction` (esbuild). Public routes send `Cache-Control` headers (§8).
  - `EdgeStack` — CloudFront distro in front of the HTTP API (+S3 assets later), WAF
    WebACL (managed common rules + rate limit) (§2, §8).
- Table name `niltv-{stage}`; key schema exactly per design §5 (PK, SK, GSI1PK/GSI1SK,
  GSI2PK/GSI2SK as attribute names).
- Lambda code in `backend/src/handlers/`, shared data-layer in `backend/src/lib/`.
  Handlers stay thin; item-shaping lives in the lib. Unit tests with vitest, colocated
  `*.test.ts`.
- Stage comes from CDK context: `cdk deploy -c stage=dev`. Never hardcode account IDs in
  code — use env at synth time.

## Mobile (`mobile/`)

- **Expo (current SDK) + expo-router**, TypeScript template. Tabs: Home, Events, Watch,
  Profile (design §3.1); detail routes come in later phases.
- **Design tokens** in `src/theme/tokens.ts` — ported from the demo's CSS custom props
  (`vision.html:15`): gold `#C2A030`, goldDeep `#8a6e1b`, goldSoft `#F7EFD6`, blue
  `#003087`, ink `#16161a`, muted `#6b6b73`, line `#ececef`, soft `#f5f5f7`, radius 12.
  Font: Sofia Sans (via `@expo-google-fonts/sofia-sans`).
- Server state: **TanStack Query**; local state: **zustand** (added when first used).
- Components in `src/components/`, screens thin in `app/`.

## Auth & claims (binding)

- **Attribute/claim spelling:** the zod contract in `@niltv/types` is authoritative
  (camelCase: `is18plus`, `playbackUrl`, …). JWT claim keys are `custom:is18plus`
  (string `"true"`/`"false"`) and `custom:role`. The design doc defers to the contract
  where spellings differ.
- **The stored USER row is the source of truth for `is18plus` and `role`.**
  `is18plus` is frozen at confirmation from the signup birthdate; role changes are
  staff/admin writes to the row. The pre-token trigger stamps claims **from the row**,
  never from live Cognito attributes — so the (necessarily client-writable, because
  required-for-signup) `birthdate` attribute can be edited later without ever
  re-deriving 18+ status.
- **Clients send the ID token** to the API (the pre-token trigger customizes ID tokens
  only on the Lite plan). Every authorization check **fails closed**: a missing
  `custom:is18plus`/`custom:role` claim is a deny, never a default-allow.
- The Cognito app client must never gain write access to `custom:role`.

## School naming

- **A school name never renders bare.** Every user-visible school mention — card
  metas, profile headers, accessibility labels, prose — reads
  "{School} NIL Student Athletes", via `nilSchool()` / `schoolMeta()` in
  `mobile/src/lib/format.ts`. Stored data stays bare; the suffix is a
  render-time concern. Channel brand names (Dore City TV, TrueBlue TV) are ours
  and are fine alone.
- **Channel surfaces read "{School}’s Athletes"** (typographic apostrophe, one
  line), via `channelDescriptor()` in `mobile/src/components/Brand.tsx`, to match
  the website's channel captions and channel-page deks (`.chan-cap`, CHAN_CAPS in
  `webapp/scripts/builders/build-sections.py`). This form replaces the one above
  on channel surfaces only: Channels-tab tiles, channel shelves, the
  channel page dek. Profile and person surfaces (athlete cards, profile headers,
  vote entries) keep `nilSchool()` / `schoolMeta()`. Schools come from the
  site's list (Duke, Vanderbilt, UNC, Mississippi State, Texas A&M, Baylor,
  Notre Dame, NC State, Syracuse, Wake Forest); never guess one.

## Content removal = tombstone, never delete

- **A content row is never `DeleteCommand`ed.** Removal writes `contentTombstone()`
  (`backend/src/lib/db.ts`) in its place, via `backend/scripts/remove-content-item.ts`,
  which also deletes the S3 media and invalidates `/video/{id}/*` on the stage's
  distribution. Why: the ingest bridge re-reads the dashboard's whole post history
  on every run and its dedupe is "row exists = skip", so a deleted post comes
  straight back. A tombstone has no entity fields, no `publishedAt` and no GSI keys,
  so public reads and the admin library never see it. The one exception is the
  `tbtv-*` archive rows
  (the TrueBlue backfill): the bridge never feeds them, so nothing re-mirrors a
  deleted one and they may be deleted outright.
- **Deploy `niltv-<stage>-admin` and `niltv-<stage>-ingest` before the first tombstone
  on a stage.** Older handlers do not tolerate one: the admin content-list
  500s its Scan page and ingest keeps the removed post in the socials CSV.

## Git

- Branch + PR to `main`; `main` is protected. Conventional-ish commit subjects
  (`backend: …`, `mobile: …`, `types: …`, `repo: …`).
