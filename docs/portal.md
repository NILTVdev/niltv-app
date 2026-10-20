# NIL TV Portal

The signed-in workspace at portal.niltv.com (portal-dev.niltv.com on dev) for
athletes, guest collaborators and staff: messaging, schedule, internal
postings, page change requests and help. Asks and claims are a preview screen
for now.

| Piece | Where |
|---|---|
| API contract and permission table | `types/src/portal.ts` |
| API stack | `backend/lib/portal-stack.ts` (`niltv-{stage}-portal`) |
| Handlers | `backend/src/handlers/portal/` |
| Shared logic | `backend/src/lib/portal/` |
| Web app | `portal/` (Vite + React) |
| Scripts | `backend/scripts/portal-grant.ts`, `backend/scripts/portal-smoke.ts` |

## Who can sign in

Everyone signs in with their niltv.com account (the website's Cognito client).
A sign-in alone gets nothing: the portal needs an active `USER#{sub} / PORTAL`
row. Roles are `athlete`, `guest`, `staff` and `admin`.

- **Athletes** come from dashboard onboarding. On prod, every 30 minutes
  `portal-roster-sync` reads accepted applications (agreement signed and
  Stripe complete, or international) and matches each to the niltv.com
  account with the same email. While `autoEnableAthletes` is off they wait as
  `ready` and an admin enables them in Athletes. Turn it on in Team & access
  once testing is done.
- **Guests** are added by staff, by email, and must already have a niltv.com
  account. They see only the groups and events they are added to.
- **Staff and admins** are added by an admin in Team & access. The first
  admin on a stage comes from the script:

  ```
  cd backend
  npx tsx scripts/portal-grant.ts --stage dev --email someone@niltv.com --role admin --desks content,support,payments
  ```

## Authorization

Two layers, both fail closed:

1. The HTTP API's JWT authorizer on every route (valid niltv.com sign-in).
2. In every handler, `authorize()` (`lib/portal/access.ts`) loads the
   member row; missing or not `active` is `403 NOT_MEMBER`. Each route then
   checks `portalCan(role, permission)` against `PORTAL_PERMISSIONS`, the same
   table the web app uses to build its menu.

The role is read from the row on every request, never from a token claim, so
removing someone or changing a role applies on their next call. Message
threads also check the membership row on every read and write.

## Data model

All in the stage's single table. Keys are built only in `src/lib/db.ts`.

| Item | Key | Notes |
|---|---|---|
| Member | `USER#{sub} / PORTAL` | role, status, roster fields, desks, email settings; GSI1 `PORTAL#MEMBERS` |
| Settings | `PORTAL#CONFIG / META` | desk emails, support email, auto-enable, welcome email |
| Conversation | `CONV#{id} / META` | `seq` counts messages; GSI1 `CONVS#ALL` or `DESK#{desk}` |
| Message | `CONV#{id} / MSG#{ulid}` | `hidden` for staff moderation |
| Retry guard | `CONV#{id} / CMID#{clientMsgId}` | a resent message lands once |
| Membership | `USER#{sub} / CONV#{id}` | read marker, mute; GSI1 mirror `CONV#{id} / USER#{sub}` lists members |
| Mail throttle | `MAILED#{target} / CONV#{id}` | one email per thread per 30 minutes |
| Event | `PEVENT#{id} / META`, `VOTE#{sub}`, `RSVP#{sub}` | GSI1 `PEVENTS#ALL` |
| Availability | `USER#{sub} / AVAIL` | GSI1 `AVAIL#ALL` |
| Posting | `POSTING#{id} / META`, `INTEREST#{sub}` | GSI1 `POSTINGS#ALL` |
| Page change request | `PREQ#{id} / META` | GSI1 `PREQS#ALL` |

Per-person rows live in the `USER#` partition so `DELETE /v1/me` removes them
with the account. Conversations use the `CONV#` model from the app messaging
plan, so the mobile app can read the same threads later.

## Messaging

- **Channels**: Announcements (staff post only), All athletes, one per campus
  channel, one per sport exactly as the signup form lists it. Active athletes
  join and leave automatically when their campus, sport or status changes
  (`syncChannelMemberships`).
- **Groups**: made by admins; the only threads guests share.
- **Desks**: Content team, Athlete support, Payments. One thread per person
  per desk. Staff answer Content team and Athlete support; only admins see
  Payments; guests cannot open Payments.
- Staff never hold channel memberships. They see every channel and group and
  keep a read marker per thread they open.
- Staff posts read as "NIL TV Team" (or the desk name) to athletes and guests;
  staff see who wrote them.
- A send is one transaction: the message, the retry guard and the `seq` bump,
  guarded by the `seq` it read. Unread = `META.seq - lastReadSeq`.
- The web app polls: the open thread every 5 seconds (`?after=`), the inbox
  every 20 seconds.

## Email

Handlers put a notice on the `niltv-{stage}-portal-notify` queue;
`portal-notify` sends through SES from portal@niltv.com. Failed notices retry
three times, then land in `niltv-{stage}-portal-notify-dlq`.

- Message emails never include the message text, wait a minute, and skip
  anyone who already read it, muted the thread, turned that email off in
  Account, or got an email about the thread in the last 30 minutes.
- Desk messages from athletes and guests go to the desk's addresses in
  Settings, or to staff who picked that desk in Account when none are set.
- Internal postings with approval on email the staff member who posted them
  for each interested athlete; the athlete gets an email when they decide.
- Help goes to the support address with reply-to set to the sender.
- Addresses on reserved test domains (`.invalid`, `.test`, `.example`) are
  never emailed.

## Run it

```
npm run test --workspace @niltv/backend        # includes the portal tests
npm run dev -w @niltv/portal                   # http://localhost:5190
```

The web app needs `portal/.env.local` (see `portal/.env.example`): the
stage's `PortalApiUrl` output, the pool id and the website client id.
`http://localhost:5190` is an allowed origin on dev.

## Deploy

```
cd backend
npx cdk diff   -c stage=dev niltv-dev-portal --exclusively
npx cdk deploy -c stage=dev niltv-dev-portal --exclusively
```

The stack only imports values the foundation stack already exports (table,
pool, website and test clients), so it deploys on its own. Context keys:
`niltv:portalUrl:{stage}`, `niltv:dashboardApiUrl:{stage}`,
`niltv:portalOrigins:{stage}` (extra CORS origins, comma separated) and
`niltv:portalRosterSync:{stage}` (`on` schedules the onboarding sync outside
prod; on dev, add athletes by hand in Team & access). Invoke
`niltv-{stage}-portal-roster-sync` with `{"dryRun": true}` to count what it
would create or update without writing anything.

## Test a deployed stage

```
cd backend
PORTAL_API_URL=<PortalApiUrl output> npx tsx scripts/portal-smoke.ts
```

Dev only. It signs up four throwaway accounts on `@niltv.invalid`, walks
every surface and access rule (46 checks), then deletes everything it made.
