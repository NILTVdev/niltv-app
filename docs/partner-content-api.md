# Partner content API

Outside networks license NIL TV video, pull it, and hold their own copies.
This document is the operator's view: what exists in the cloud, how
partners and keys are managed, and how the pieces fit.

## What is deployed

| Piece | Stack | What it does |
|---|---|---|
| `GSI3` syndication index | foundation | Sparse index of every content row that is published with an owned/licensed rights record. Withdrawn rows keep their key as tombstones. |
| Partner key pepper | foundation | Secrets Manager salt for API key hashes. Keys are stored only as `PARTNERKEY#{sha256(pepper:key)}`. |
| Mezzanine output | media | Every uploaded master now also produces `video/{id}/mezz.mp4` (H.264 High, AAC, moov first). `masters/{id}/vertical.mp4` produces `video/{id}/vertical.mp4` only. |
| Partner download distribution | edge | A second CloudFront distribution that requires a signed URL. Serves the video bucket with origin path `/video`, plus `/masters/*` and `/originals/*` from the masters bucket. `/video/*` on the main distribution stays public. |
| `/feeds/*` | edge | Media RSS + JSON feeds per partner, short cache. |
| `/partner/v1/*` | api | Keyed read API behind a Lambda authorizer (`x-api-key`). Routes: `me`, `series`, `channels`, `content`, `content/{id}`, `changes`. |
| Admin routes | admin | `/admin/series`, `/admin/partners`, key rotate/revoke, `/admin/content/{id}/withdraw` and `/restore`, tagging fields on `/admin/content`. |
| Jobs | partner | `feed-build` (every 15 min), `partner-events` (table stream → webhook queue), `webhook-deliver` (signed POST, retries, DLQ + alarm). |

The routes exist in every stage. `PARTNER_API_ENABLED` decides whether they
answer. It comes from the CDK context key `niltv:partnerApi:<stage>` and
defaults to on in dev and off elsewhere (`backend/lib/api-stack.ts`).

## One rule, everywhere

`backend/src/lib/syndication.ts` is the only place that decides what may
leave the platform. `baseEligibility` (published, not withdrawn, rights
owned/licensed, school marks cleared, music none/cleared, not expired,
has a file; availability windows are not enforced) and `partnerScope` (partner active, term
open, series or channel licensed, asset type licensed) are applied by the
API, the feed builder and the admin surfaces. `toPartnerAsset` turns a row
into the asset a partner sees; the Media RSS and JSON writers format that.

`rightsConfirmed` on a content row keeps its meaning ("fine in our app"). The
new `rights` record is a separate gate, and an absent record is ineligible.
Ingested reels therefore never syndicate until an editor tags them.

## Partners and keys

Partners, their licences and their keys are managed through the admin API
(`/admin/partners`, `/admin/partners/{id}/rotate-key`, `/revoke-key`). Only a
salted hash of each key is stored. Rotation leaves the outgoing key valid for a
seven-day grace, and at most one grace key exists; revocation cuts every key
the partner row tracks. Both take effect within the authorizer's five-minute
cache. A suspended partner's key is rejected, its next feed build is empty, and
its webhooks stop.

## Withdrawal

`POST /admin/content/{id}/withdraw {"reason":"…"}` stamps `withdrawnAt`,
keeps the row in the index as a tombstone, drops it from every feed on the
next build, makes `/partner/v1/content/{id}` answer 404, lists it in
`/partner/v1/changes` as `content.withdrawn`, and fires the webhook.
`/restore` reverses it. Neither touches the app.

## Signed URLs

Every media URL a partner receives is signed for the partner download
distribution with an expiry aligned to the next weekly boundary
(`weeklyExpiry`): every URL minted in the same Monday-to-Sunday week is
byte-identical, so a poller's cache stays warm across feed rebuilds, and
every URL has at least seven days of life when minted. The api and partner
stacks read the distribution domain and key-pair id from SSM
(`/niltv/<stage>/partner-dl/domain`, `/niltv/<stage>/partner-dl/key-pair-id`,
written by the edge stack) and the private key from Secrets Manager.

## Webhooks

Payload: `{ eventId, type, contentId, updatedAt, sentAt }` with
`type ∈ content.published | content.updated | content.withdrawn`. Headers:
`x-niltv-timestamp` and `x-niltv-signature: sha256=HMAC_SHA256(secret, "{timestamp}.{body}")`.
Five attempts over about 25 minutes, then the dead-letter queue and an
alarm. `/partner/v1/changes?since=` is the replay path.
