# NILTV App

Mobile home of the NIL TV network — watch athlete content, take part in live NIL STAR
events, follow athletes and channels.

Developer docs are in [docs/](docs/). Product plans and specs are maintainer
documents kept outside this repo.

## Layout

```
types/     @niltv/types — zod API contract + shared types + demo fixtures (source of truth)
backend/   AWS CDK app  — DynamoDB, Cognito, HTTP API + Lambdas, CloudFront/WAF (us-east-1)
mobile/    Expo app     — React Native client (iOS-first)
```

## Quick start

```bash
npm install                 # installs all workspaces
npm run typecheck           # typecheck everything
npm run synth               # cdk synth (backend)
npm start                   # run the app (Expo Go / simulator)
```

> **Run the app from the repo root with `npm start`** (or from `mobile/`). Don't run
> `npx expo start` at the root itself — Expo would treat the monorepo root as the app,
> auto-generate a stray `tsconfig.json`, and fail with
> `Unable to resolve "../../App" from "node_modules\expo\AppEntry.js"`.

## How to test

Three tiers. There is no local backend: Lambdas, DynamoDB and Cognito only
exist as deployed stages, so backend changes are exercised on dev.

**Local** (no AWS account needed). The same gate CI runs on every PR:

```bash
npm run typecheck && npm test && npm run lint && npm run synth
cd mobile && npx expo export --platform web      # smoke build; catches module-scope faults
npm start                                         # the app on web or a simulator, against the dev API
```

**Deploys.** Maintainers deploy the stacks and run the acceptance, security
and partner batteries against a stage after a merge. What each battery checks,
and how to read a failure, is in [docs/api-testing.md](docs/api-testing.md).

## Backend deploys

CDK, `us-east-1`, AWS profile `default` (NILTV account `858321320457`). Stages are
stack-name-prefixed (`niltv-dev-*`, `niltv-prod-*`).

```bash
cd backend
npm run deploy:dev
```

## Conventions

See [docs/CONVENTIONS.md](docs/CONVENTIONS.md). Rules that matter most:
API shapes live **only** in `@niltv/types` (zod) — client and Lambdas both import them;
push a branch + PR (main is protected); no secrets in the repo, ever.

## Secret hygiene

Every commit is scanned for secret-shaped strings, locally and in CI.

1. Install gitleaks once: `go install github.com/zricethezav/gitleaks/v8@v8.24.3` (or `brew install gitleaks`).
2. Point git at the repo's hooks once per clone: `git config core.hooksPath .githooks`.

The `gitleaks` workflow runs the same scan over the full history on every pull request and every push to `main`. Real credentials live in `.env` (ignored) or on the AWS side, never in the tree. If one ever lands in a commit, rotate it first, then rewrite history.

Maintainers and CI also run a supplementary private gitleaks rule file.

## License

The code in this repository is released under the MIT License (see
[LICENSE](LICENSE)). The license covers the code only. It does not grant any
right to:

- the NIL TV, NIL Star and TrueBlueTV names and logos, the campus channel
  marks, or any third-party brand, school, conference or league mark that
  appears in the assets;
- photographs, video, captions and other media of athletes and other people;
- athlete, applicant, subscriber and partner data, including anything the
  pipelines in this repository produce.

Third-party components keep their own licenses; see THIRD_PARTY_NOTICES.md
where present.
