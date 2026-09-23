# NILTV — operating context

Read this first. It is the orientation doc for anyone (human or Claude) picking the
project up cold. It is kept short on purpose; it points at the deeper docs rather than
repeating them.

## What this is

NILTV is a college-athlete media network. This monorepo is the mobile app and its
backend: fans browse athlete video, follow creators, and vote in prize competitions
(NIL STAR).

Almost all content arrives automatically from Instagram via an ingest bridge — staff
upload is the exception, not the rule. Direct-mp4 is the permanent design for social
clips; MediaConvert exists only for staff uploads.

## Repo map

| Workspace | What it is |
|---|---|
| `types/` | The zod API contract. **The only place API shapes are defined.** Both sides import it. |
| `backend/` | AWS CDK: six stacks per stage + one Lambda per resource group. |
| `mobile/` | The Expo SDK 57 app (iOS/Android; web is dev-only, see gotchas). |
| `admin/` | Vite/React staff tool for content, profiles, events, newsletter export. |

`docs/CONVENTIONS.md` is binding. The short version: API shapes only in `@niltv/types`;
`is18plus`/`role` come from the stored USER row, never live Cognito attributes;
camelCase per the contract.

## Environments

Two stages, `dev` and `prod`, each a set of CDK stacks
(`niltv-{stage}-{foundation,api,media,edge,admin,ingest,partner}`) in one AWS
account. Stage values live in `backend/cdk.json` context and in the mobile and
admin config files. Deploys and the environment map are maintainer tasks and
are documented outside this repo; contributors work against the tests and a
dev stack.

Architecture pointers:

- Social ingest: a scheduled Lambda (`ingest-social`) reads the separate
  dashboard API and mirrors new posts. Content removal must tombstone (see the
  gotchas).
- Partner content API: `/partner/v1/*` behind an `x-api-key` authorizer. What
  may leave the platform is decided only in `backend/src/lib/syndication.ts`.
  Guide: `docs/partner-content-api.md`.
- Content foundation (tagging): `source` on a content row is verbatim and never
  edited; `backend/src/lib/enrich.ts` derives the rest and skips any field in
  `overrides`. Guide: `docs/content-foundation.md`.

## Working on it

```
npm run typecheck                      # all workspaces
npm run test --workspace @niltv/backend # includes CDK assertions in lib/*.test.ts
npm run test --workspace mobile        # vitest (not jest-expo — React 19)
cd mobile && npx expo lint
cd mobile && npx expo export --platform web   # smoke build; catches module-scope faults
```

Media maintenance (all idempotent and safe to re-run). Deploy `<stage>-media`
**before** running `optimize-video` — see the gotcha below.

```
cd backend
npx tsx scripts/optimize-video.ts --stage <stage> --dry-run  # survey clip bitrates
npx tsx scripts/optimize-video.ts --stage <stage>            # re-compress >3 Mbps
python scripts/optimize-posters.py --stage <stage>           # shrink posters, stamp Cache-Control
python scripts/poster-audit.py --stage <stage> --fix        # letterboxed/landscape/missing posters -> full-bleed frame
npx tsx scripts/repair-ingest-paths.ts --stage <stage>       # undo HLS-path damage
aws cloudfront create-invalidation --distribution-id <id> --paths "/video/*" "/v1/*"
```

Two things bite on Windows here. **Quote invalidation paths with double quotes** —
`cmd.exe` does not treat `'…'` as quoting and passes the single quotes through, which
CloudFront rejects as an invalid path. And `optimize-posters.py` needs `boto3` and
`pillow`, which are not part of the npm workspace and are *not* inherited by a
virtualenv: `pip install boto3 pillow` in whichever interpreter you run it with.

CI runs exactly these plus `cdk synth`. **Everything above must pass before a push.**

Fast feedback loop, in order of fidelity: web (`npx expo start`, instant, but see
gotchas) → the Android dev-client APK (`eas build --profile development`, one build then
instant reload with real native behaviour) → `--profile preview` (installable APK against
prod) → `--profile production` (TestFlight). EAS Update ships JS-only changes OTA to
installed builds. The update runtime is the app version (`runtimeVersion.policy:
appVersion`): whenever a change needs a new native build (a new native module, a
config plugin, anything `app.json` turns into Info.plist or the manifest), bump
`version` in `mobile/app.json` in the same PR, so an update that imports the new
module can never reach an installed build that lacks it.

## Gotchas that have already cost time

- **Never run `backend/scripts/seed.ts` against prod.** It loads demo fixtures. Prod was
  bootstrapped with `scripts/bootstrap-stage.ts`, which writes real launch data only.
- **Web is not the app.** It is a dev convenience. Several "bugs" reported from
  `expo start` on web were browser policy, not app faults: unmuted autoplay is blocked,
  `expo-video` needs explicit width/height (absoluteFill alone leaves it at intrinsic
  size), and fast scrolling cancels in-flight media requests, which surfaces as
  `AbortError` noise. Judge playback on a device.
- **React Native types can lie.** `ImageLoadEventData.source` is typed as always present
  and is absent on react-native-web — that shipped a crash past a green typecheck. Prefer
  extracting such logic into a pure helper and unit-testing the real platform payloads.
- **The React Compiler is on.** `useCallback` is not a strong enough identity guarantee
  for props that must never change (`onViewableItemsChanged` throws a VirtualizedList
  invariant). Freeze such props in a `useState` initializer and delegate through a ref.
- **Git Bash mangles leading-slash arguments** (SSM parameter names, CloudWatch log group
  names). Prefix with `MSYS_NO_PATHCONV=1`.
- **`gh pr edit` fails on this repo** (projects-classic GraphQL deprecation). Use
  `gh api -X PATCH repos/NILTVdev/niltv-app/pulls/N`.
- **tsx scripts in `backend/` need an async `main()`** — top-level await is not supported
  under the cjs output.
- **Only one `cdk` process may touch `cdk.out`.** Concurrent deploys fail with a lock error.
- **PRs are squash-merged. Commits pushed to a branch after its PR merged are orphaned.**
  The repo auto-deletes branches on merge, so a later push fails loudly instead of
  vanishing. One branch, one PR; start a new branch for follow-up work. If something
  does vanish it is recoverable: `git log --all --oneline -- <path>` then
  `git checkout <sha> -- <path>`.
- **Deployed infrastructure can outlive its source.** When something looks wrong, check
  both: `aws cognito-idp describe-user-pool`, `aws apigatewayv2 get-stage` and friends
  tell you what is actually running, which is not always what `main` says.
- **A guard in source is not a guard until it is deployed.** Work started before the
  deploy runs against the old handler. Re-compression jobs submitted before the
  `purpose: "optimize"` skip in `transcode-complete` is live get their rows rewritten to
  `/index.m3u8` + `poster.0000000.jpg` and un-published.
  `scripts/repair-ingest-paths.ts` puts such rows back. **Deploy the handler, then start
  the work that triggers it.**
- **Social clips are direct-mp4; the MediaConvert pipeline is not for them.** Any
  COMPLETE event stamps HLS paths onto the row unless the job carries
  `userMetadata.purpose = "optimize"`. New MediaConvert use for social content must
  carry that flag or extend the guard.
- **Instagram covers are not posters.** Ingest mirrors the creator's cover image as
  `poster.jpg`, and a cover is often a letterboxed 16:9 shot inside the 9:16 canvas (or
  landscape, or absent). Every surface renders posters in a 9:16 frame, so those show black
  bars. The Lambda cannot decode video, so the check lives outside it: run
  `scripts/poster-audit.py --stage <stage> --fix` after every ingest run (it scans the
  clip for a full-bleed frame and rewrites the poster; needs `opencv-python-headless`).
- **`.expo/types/router.d.ts` is generated** (gitignored). Adding a route makes typecheck
  fail until the dev server regenerates it.
- **Metro needs an uppercase drive letter on Windows.** From a `cmd` prompt at
  the repo's `mobile` folder via a lowercase drive letter, `expo export` and `eas update` fail with
  "Unable to resolve module @niltv/types": the workspace symlink's real path starts
  with an uppercase drive letter and Metro treats it as outside the project. `cd /d` into it with the drive letter uppercased
  first (Git Bash and PowerShell already report the drive uppercase).
- **Content removal must tombstone, never delete.** The ingest bridge re-mirrors any post
  the dashboard still serves, so a deleted row comes back on the next run. Use
  `scripts/remove-content-item.ts`, which writes a tombstone row (`contentTombstone` in
  `src/lib/db.ts`) that ingest and the admin list honour, and invalidates
  `/video/{id}/*` at the edge (media is cached immutable for a year). **Deploy
  `niltv-<stage>-admin` and `niltv-<stage>-ingest` before the first tombstone on a
  stage**: an older admin content-list `Content.parse`s every scanned row and 500s the
  staff library on a tombstone, and an older ingest keeps the removed post in the
  socials CSV with a link to the deleted mp4. Same rule as above: deploy the handler,
  then start the work that triggers it.

## Where the state lives

- `docs/CONVENTIONS.md`, `docs/content-foundation.md`, `docs/partner-content-api.md`
  and `docs/api-testing.md` are the developer documents.
- Plans, specs, changelogs and runbooks are maintainer documents kept in a
  separate private repository.
