# API testing

Four layers, cheapest first. CI runs the first. The rest run against a deployed
stage and are what "tested" means before a prod deploy or a partner key goes out.

| Layer | What | Command | Needs |
|---|---|---|---|
| Unit | handlers, rules, stacks, mobile | `npm test` (root) | nothing |
| Pipeline acceptance | today's Instagram posts became tagged, credited, served rows | `npx tsx scripts/ingest-acceptance.ts --stage dev` | AWS creds |
| Security probes | headers, CORS, input validation, auth on every route family, signed downloads | `npx tsx scripts/api-security-check.ts --stage dev --mint` | AWS creds for `--mint` and the download probes; none otherwise |
| Partner surface | end to end: tag, key, list, detail, download, withdraw, feeds, webhooks | `npx tsx scripts/partner-smoke.ts --stage dev` then `scripts/partner-admin-flow.ts` | AWS creds; admin flow needs the dev test client |

All scripts run from `backend/`, print PASS/FAIL per check, exit 1 on any
failure, and take `--json <file>` for a report. They refuse prod without
`--confirm-prod`. Nothing in the security probes writes on the far side: every
request is unauthenticated or invalid by construction. `--mint` writes one
throwaway partner row and its key on dev and deletes both afterwards.

## What a failure means

- **headers / cors** failing on a stage almost always means the edge stack is
  behind main (the hardening headers and the origin allowlist live in
  `backend/lib/edge-stack.ts`, applied by CloudFront). Deploy `niltv-<stage>-edge`.
- **authed / admin** failing is serious: a route answered without a token.
  Check the route table in `api-stack.ts` / `admin-stack.ts` first; every
  route must carry an authorizer.
- **partner** 5xx on any input is a bug in the handler: inputs are the
  partner's, and a 500 on a bad cursor pages someone at 3 am. Both partner
  list routes decode cursors with `decodeSyndicationCursor` and turn a
  DynamoDB ValidationException into a 400.
- **public** 403 with a non-JSON body on a hostile id is the WAF or CloudFront
  refusing it before the API; that is a pass.
- **downloads** failing means the signed-URL distribution is open. Stop and
  look before anything else.

## Reading the acceptance report

`ingest-acceptance.ts` checks every row published in the last 26 hours (or
`--since N`) and one whole-library invariant: no published row without a
`source` record. A failure names the row and the rule. The usual causes:

- `channel row carries school and account`: a channel row predates the
  foundation; re-run `backfill-standard.ts --apply` for the stage.
- `no poster → app holds with reason`: the row was tagged before the poster
  rule existed; the same re-run fixes it.
- `real credit points at a complete profile`: a roster profile lost its school
  or sport upstream; fix it in the dashboard, the nightly sync carries it over.
- `public API serves the row` on a fresh row: CloudFront cache or the row is
  still transcoding; re-run in a few minutes before reading anything into it.

`--invoke` runs the stage's ingest Lambda first, so the whole path can be
exercised on demand instead of waiting for the next ingest run.
