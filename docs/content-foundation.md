# Content foundation

How a clip becomes a tagged, credited, rights-typed asset without a person
touching it, and what a person does when the pipeline cannot decide. This is
the operator's view of the enrichment pass.

## The rule that makes it safe

- `source` on a content row is what the source said, verbatim. Adapters write
  it once. Nothing else edits it.
- Every derived field (title, description, summary, keywords, sport, school,
  contentType, athlete credit, rights defaults, QC) is recomputed from
  `source` by `backend/src/lib/enrich.ts`. The pass can run again at any time.
- A field named in `overrides` was set by a person and is never recomputed.
  Admin edits record overrides for the fields whose value changed;
  `clearOverrides` hands a field back to the pass.

## What runs, and when

| Time (UTC) | Job | Does |
|---|---|---|
| hourly, before :30 | dashboard pulls | owned and collab posts from Instagram |
| 06:15 | `roster-import` | dashboard ambassadors → Profile rows (handle, school, sport, campus, year, cohort, previous handles). Imported profiles are `athlete` only; the ambassador flag stays a staff decision. |
| hourly at :30 | `ingest-social` | mirrors new video posts, then runs the enrichment pass on each with the roster loaded once per run |
| on edit | admin content upsert | records overrides, bumps `syndicationUpdatedAt`, re-stamps QC and the syndication index |

## What the pass derives

| Field | From | Confidence |
|---|---|---|
| title, description, summary, keywords | caption cleanup (handles, hashtags, emoji stripped; first sentence; word-boundary cap) | deterministic |
| title, when the caption has fewer than two words | the title ladder in `titleFor()`: the credited athlete, then a one-word caption (shorthand like "DITL" spelled out), then the creator's handle with school and sport, then school, sport and format ("Duke Soccer Media Day"), then the channel's people ("Duke’s Athletes"). Never a generic "New on …" line. `titleSource` on the row records the rung | deterministic; every rung but the caption adds the `title needs writing` queue reason until staff save a title in the admin library |
| athleteId, featuredAthleteIds | author handle and caption mentions matched to profiles by current or previous handle; our own accounts are never people | deterministic; unmatched handles go to `unresolvedHandles` |
| school | credited athlete's school, else the campus channel's school (`ACCOUNT_SCHOOLS`) | deterministic |
| sport | the sport on screen: a sport hashtag (0.8), else caption words (0.5), else the credited athlete's roster sport as a weak hint (0.4) | scored |
| athlete credit | a real profile takes the credit only when it has a name, a school and a sport; otherwise the channel keeps it and the person is still recorded in featuredAthleteIds with an `athlete profile incomplete` queue reason | deterministic |
| contentType, contentTypes | hashtag and caption signals per type (0.9 / 0.6) | scored; below 0.9 the Claude classifier may be asked |
| rights.status, rights.music | defaults by origin (`source.kind`), set by rule in `rightsDefaults()` in `enrich.ts` | recomputed unless a person set the field (`rights.<field>` in overrides) |
| rights.logoCleared | set by rule from the row's school and the block list `POLICY#schools.blockedSchools`; see `enrich.ts` | recomputed unless a person set it |
| qc | per-surface verdict with reasons | recomputed on every write |

Availability windows and the series delay are not enforced; an asset is
available once ingested.

## The queue

`qc.reasons` on each row is the queue. `scripts/readiness-report.ts` totals it
per surface and per partner. It is cleared with
`scripts/import-overrides.ts` (a CSV of ids and the fields a person decided) or
through admin, which records the same overrides.

## Library sync to the dashboard

After each hourly ingest run, `src/lib/library-sync.ts` sends the dashboard a
full snapshot of the library with its labels (`POST /api/library/sync`, body
`DashboardLibrarySync` in `@niltv/types`, snake_case because it mirrors the
dashboard's endpoint). The dashboard joins it to its Instagram view counts by
`ig_post_id`. Only public `/video/*` URLs and labels leave; the rights record
does not. Rows missing from the snapshot (tombstones) are marked removed there.

- Flag: context `niltv:librarySync:{stage}` sets `LIBRARY_SYNC_ENABLED` on the
  ingest function. On in dev, off in prod until the dashboard endpoint ships.
- Target: `LIBRARY_SYNC_URL`, the stage's own dashboard (dev posts to
  `https://api-dev.niltv.com`, prod to `https://api.niltv.com`; override with
  context `niltv:dashboardApiUrl:{stage}`). It is separate from
  `DASHBOARD_API_URL`, which still reads prod brand posts in every stage. The
  dev dashboard must serve the endpoint before the dev sync does anything.
  Each stage sends `stage` in the body; the dashboard should scope removals to
  rows of the same stage.
- A failed sync is logged (`library-sync: status=failed ...`) and the run
  carries on. Above 5000 rows the sync skips rather than truncate, since a
  partial full snapshot would mark the rest removed.
- Contract fixture for the dashboard's tests:
  `backend/test/fixtures/dashboard-library-sync.sample.json`, produced by the
  mapping code. Regenerate after a mapping change with
  `UPDATE_FIXTURES=1 npx vitest run src/lib/library-sync.test.ts` in `backend/`.

## Bringing the library up to standard

```
cd backend
npx tsx scripts/backfill-standard.ts --stage dev --roster --sheet <roster.csv> --taxonomy <taxonomy.csv> --report backfill-dev.json
npx tsx scripts/backfill-standard.ts --stage dev --roster --sheet <roster.csv> --taxonomy <taxonomy.csv> --apply
npx tsx scripts/readiness-report.ts --stage dev
```

Dry run first. The report carries the accuracy of the automatic sport and
content-type verdicts against the taxonomy sheet before the sheet's
labels are applied as overrides; that number is what future clips can be
trusted to. Add `--llm` with `ANTHROPIC_API_KEY` in the environment to ask
Claude about the clips the rules were not sure of. Prod needs `--confirm-prod`.

## Vocabularies

`Sport` and `ContentType` in `types/src/primitives.ts` are the controlled
lists, seeded from the taxonomy sheet. Adding a value is a types change plus
a rule in `enrich.ts`; nothing else needs to know.
