# NIL TV Portal

The signed-in workspace at portal.niltv.com (portal-dev.niltv.com on dev) for
athletes, guest collaborators and staff: messaging, schedule, internal
postings, the Content Hub, page change requests and help.

| Piece | Where |
|---|---|
| API contract and permission table | `types/src/portal.ts` |
| API stack | `backend/lib/portal-stack.ts` (`niltv-{stage}-portal`) |
| Handlers | `backend/src/handlers/portal/` |
| Shared logic | `backend/src/lib/portal/` |
| Web app | `portal/` (Vite + React) |
| Scripts | `backend/scripts/portal-grant.ts`, `backend/scripts/portal-smoke.ts`, `backend/scripts/portal-vapid.ts` |

## Who can sign in

Everyone signs in with their niltv.com account (the website's Cognito client).
A sign-in alone gets nothing: the portal needs an active `USER#{sub} / PORTAL`
row. Roles are `athlete`, `guest`, `staff` and `admin`.

- **Athletes** come from dashboard onboarding. On prod, every 30 minutes
  `portal-roster-sync` reads accepted applications (agreement signed and
  Stripe complete, or international) and matches each to the niltv.com
  account with the same email. The application's college email is never used:
  it is free text, so it cannot pick an account. While `autoEnableAthletes` is
  off they wait as `ready` and an admin enables them in Athletes. Turn it on in
  Team & access once testing is done, together with `welcomeEmail`, because a
  welcome only goes out at the moment of release. The next run releases everyone
  already waiting. It never touches a disabled athlete.
- **Accepted athletes with no account** go on a pending list instead. Staff see
  them on Athletes under the No account yet status. Once `welcomeEmail` is on,
  the sync sends each one an invite, retried daily until one really goes out.
  An admin can also send one by hand, whatever the switch says, at most once a
  day per person. The invite links to `/create-account` in the portal with the
  address filled in. The person makes the account there, enters the emailed
  code, and the next sync connects them and clears the row. If they used another
  address, an admin links it from the same row.
- **Unfinished sign-ups** block an address: it cannot sign up again, sign in or
  reset. Someone with the password gets the code step by signing in. Otherwise the
  sync deletes one older than a day on a pending address, and an admin's Send again
  deletes it at once. There is deliberately no way to confirm an account with only
  a code, because whoever made the account holds its password.
- **Guests** are added by staff, by email, and must already have a niltv.com
  account. They see only the groups and events they are added to.
- **Staff and admins** are added by an admin in Team & access. The first
  admin on a stage comes from the script:

  ```
  cd backend
  npx tsx scripts/portal-grant.ts --stage dev --email someone@niltv.com --role admin --desks content,support,payments
  ```

Only a confirmed account with a verified email counts when the portal looks one
up by address (`lib/portal/accounts.ts`). Anyone can type any address into a new
account, so an unproven address never picks up someone else's access. The pool
also holds an email change until the new address is verified (`keepOriginal`),
which needs `niltv-{stage}-foundation` deployed.

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
| Member | `USER#{sub} / PORTAL` | role, status, roster fields, desks, notification settings, `lastSeenAt`; GSI1 `PORTAL#MEMBERS` |
| Settings | `PORTAL#CONFIG / META` | desk emails, support email, auto-enable, welcome and invite emails, the two notification switches |
| Pending athlete | `PORTAL#PENDING / APP#{applicationId}` | an accepted athlete with no confirmed account: name, email, campus, sport, `firstSeenAt`, `invitedAt` |
| Conversation | `CONV#{id} / META` | `seq` counts messages; GSI1 `CONVS#ALL` or `DESK#{desk}` |
| Message | `CONV#{id} / MSG#{ulid}` | `hidden` for staff moderation |
| Retry guard | `CONV#{id} / CMID#{clientMsgId}` | a resent message lands once |
| Membership | `USER#{sub} / CONV#{id}` | read marker, mute, latest @mention; GSI1 mirror `CONV#{id} / USER#{sub}` lists members |
| Notification state | `USER#{sub} / NOTIFY` | pending summary, backoff counters, today's push count; GSI1 `NOTIFY#DUE` while a summary is pending |
| Push device | `USER#{sub} / PUSH#{id}` | one browser subscription (id = hash of the endpoint) |
| Desk alert state | `PORTAL#NOTIFY / DESK#{desk}` | when the desk was last alerted, the day of the last morning list |
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
- **@mentions** work in groups and channels, never desks. The server keeps
  only people who can read the thread. The @ list never shows staff to
  athletes or guests, since staff post as the team.
- **Important**: staff can flag a post in Announcements. It emails everyone
  who keeps announcements on, right away (when activity emails are on).
- A desk thread is **waiting** (`waitingSince` on META) from the first
  athlete or guest message staff have not answered until a staff reply.

## Notifications

One ladder, quietest first:

1. **The badge** in the portal, for everything. The tab title and the
   installed app's icon show the unread count.
2. **A phone or browser notification** (web push), for what is addressed to
   the member.
3. **One summary email**, only for what is still unseen an hour later. At
   most daily while they stay away, never 10 PM to 8 AM in their zone.

Two switches in Settings turn on the outside channels: `activityEmails` and
`webPush`. **Both are off until testing ends.** With both off, nothing about
messages, postings or the schedule leaves the portal.

Each member picks a cadence per topic in Account: right away (push, plus the
summary if still unseen), daily summary, or off.

| Topic | Covers | Default |
|---|---|---|
| `direct` | desk replies, @mentions, posting decisions (staff: desk messages) | right away |
| `groups` | group chats | right away |
| `announcements` | Announcements | right away |
| `channels` | All athletes, campus and sport chats (never push) | off |
| `schedule` | Pick a time events (`poll` in the code), set times, new times, cancellations | right away |
| `postings` | new internal postings | daily |

How it flows:

- Handlers put a notice on `niltv-{stage}-portal-notify`. `portal-notify`
  (`handlers/portal/notify.ts`) decides per recipient: push now, count it
  toward their summary, or (rarely) email now. Failed notices retry three
  times, then land in `niltv-{stage}-portal-notify-dlq`.
- `portal-summary` (`handlers/portal/summary.ts`) runs every 15 minutes,
  one run at a time. It sends summaries that have come due and the staff
  desk alerts.
- Every timing rule is a pure function in `lib/portal/prefs.ts`, with tests.

Rules:

- Message notices wait a minute. Anyone who read the message or muted the
  thread is skipped. A mention still gets through a mute.
- "Seen" is any API request (recorded at most every 2 minutes in
  `authorize`). Seen in the last 3 minutes means no push. Opening the portal
  after activity arrived cancels the summary for it.
- Summaries: first one an hour after the activity (8 AM for daily topics).
  Then at most every 3 hours for someone who keeps coming back, daily while
  they stay away, weekly after three ignored in a row, and none after seven
  until they come back. Content is worked out when it sends, so an answered
  poll never shows up. Message lines are counts, never message text.
- Push: one notification per thread (tag `conv-{id}`), replaced as messages
  arrive. Non-direct pushes are capped at 6 a day and held at night. Direct
  pushes may come at night. `previews` off shows only who wrote. Payloads are
  encrypted for the browser.
- Right away by email: an announcement staff flag **important**, and an
  event cancelled or moved within 48 hours.
- Staff desks: athlete messages push the desk's staff. Email is a desk
  alert when a thread starts waiting (at most hourly), plus a 9 AM list of
  threads waiting more than a day. Both use the team zone and the desk
  addresses in Settings, else the desk's staff.
- Always on, whatever the switches say: approval-posting interest to the
  staff member who posted it, page change requests to Athlete support, Help
  to the support address (reply-to the sender), and the welcome and invite emails (their
  own switch).
- Reserved test domains (`.invalid`, `.test`, `.example`) are never emailed.

### Web push setup

The web app is installable (`portal/public/manifest.webmanifest`,
`portal/public/sw.js`). On iPhone and iPad, push works only after the
member adds the portal to their Home Screen (iOS 16.4 and later). Installed,
the app keeps people signed in (localStorage); browser tabs still use
sessionStorage. The app asks for notification permission only after a tap,
never on first load.

Keys live in SSM: `/niltv/{stage}/portal-vapid-public` (String) and
`/niltv/{stage}/portal-vapid-private` (SecureString, readable by
`portal-notify` only). Create them once per stage:

```
cd backend
npx tsx scripts/portal-vapid.ts --stage dev
```

Then turn on `webPush` in Settings. Subscriptions are accepted only for the
browser push services (`isPushServiceUrl` in the contract), so the notifier
never calls any other host. Rotating keys (`--rotate`) makes every browser
subscribe again.

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

The web app deploys with `python portal/scripts/deploy.py --stage dev`.
Prod (`--stage prod --confirm-prod`) refuses a dirty tree and any HEAD that
is not on `origin/main`. Each build carries `/version.json` with the commit,
branch, build time and stage, so `curl https://portal.niltv.com/version.json`
shows what is live. Response headers (CSP, HSTS, framing, caching) live in
`portal/customHttp.yml`. Amplify keeps them at app level, so dev and prod
share them. Only a prod deploy from main sets them. A dev deploy leaves them
alone and warns when the file differs from what is live. Change headers in
that file only. The prod runbook is kept with the team's
internal docs.

## Alarms, logs and redrive

Every alarm pages `niltv-{stage}-alerts`, the topic the api stack owns.

| Alarm | Fires when |
|---|---|
| `niltv-{stage}-portal-api-5xx` | The portal API served a 5xx in 5 minutes. The router turns a thrown route into a 500, so this is the only signal for API handlers. |
| `niltv-{stage}-portal-notify-errors`, `-portal-summary-errors`, `-portal-roster-sync-errors` | That function threw in 5 minutes. |
| `niltv-{stage}-portal-notify-dlq` | A notice used up its 3 tries and sits in the dead-letter queue. |
| `niltv-{stage}-portal-notify-queue-age` | The oldest notice has waited 15 minutes. The notifier is stuck. |
| `niltv-{stage}-portal-swallowed-errors` | A path that logs and carries on failed: `email failed`, `push failed`, `one recipient failed`, `one summary failed`, `desk alert failed`, `notice enqueue failed`. |
| `niltv-prod-ses-bounce-rate`, `niltv-prod-ses-complaint-rate` | SES reputation reached 4% bounces or 0.08% complaints. AWS reviews the account at 5% and 0.1%. Prod only, because dev and prod share the account. |

Logs:

- API access log: `/aws/apigateway/niltv-{stage}-portal-access`, one JSON
  line per request with request id, time, route, path, status, source IP and
  the caller's Cognito sub. No headers and no bodies. Kept one month.
- Audit lines: every member, settings, hide, group, posting decision and
  ask decision write logs one line with `"audit":"portal"`, the actor's sub,
  the action, the target and the fields that changed. Find them in Logs
  Insights over the portal log groups with
  `filter audit = "portal" | sort @timestamp desc`.

Redrive the notify dead-letter queue (messages stay 14 days). Fix the cause
first, or the notices fail again and return to the DLQ.

```
STAGE=prod
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
DLQ_URL=$(aws sqs get-queue-url --queue-name niltv-$STAGE-portal-notify-dlq --query QueueUrl --output text)

# Look without removing (they reappear after 30 seconds)
aws sqs receive-message --queue-url "$DLQ_URL" --max-number-of-messages 10 --visibility-timeout 30

# Move them all back to the notify queue
aws sqs start-message-move-task \
  --source-arn arn:aws:sqs:us-east-1:$ACCOUNT:niltv-$STAGE-portal-notify-dlq \
  --destination-arn arn:aws:sqs:us-east-1:$ACCOUNT:niltv-$STAGE-portal-notify
aws sqs list-message-move-tasks --source-arn arn:aws:sqs:us-east-1:$ACCOUNT:niltv-$STAGE-portal-notify-dlq
```

Bounce and complaint events: the `niltv-transactional` configuration set
sends them to the SNS topic `niltv-ses-events`. That topic was made by hand
and no stack owns it, so nothing in this repo subscribes to it. Subscribe a
team inbox once, then confirm from the email:

```
aws sns subscribe --topic-arn arn:aws:sns:us-east-1:$ACCOUNT:niltv-ses-events \
  --protocol email --notification-endpoint <team inbox>
aws sns list-subscriptions-by-topic --topic-arn arn:aws:sns:us-east-1:$ACCOUNT:niltv-ses-events
```

Each event arrives as one JSON email. Check that an address is not
suppressed with `aws sesv2 get-suppressed-destination --email-address <address>`
and clear it with `aws sesv2 delete-suppressed-destination --email-address <address>`
once the cause is fixed.

## Pick a time

Two or more times make a Pick a time event (`poll` in the code). Invitees tick every
time that works or say none work, and a saved answer with nothing ticked counts as an
answer. Staff see the picks, who said none work, who has not answered, and can send a
reminder once a day while notifications are on. Locking a time marks everyone who picked
it as going, and they can change that. Reopen takes the set time off, clears replies and
keeps picks. Adding a time asks everyone again with their picks kept. Once every time has
passed the event leaves members' screens, and staff find it under Times passed.

## Content Hub

Staff post an ask with a format, a description, a target (every athlete, one
campus or one sport) and an optional approval step. Asks have no spots and stay
open until staff close them. Nothing on an ask is paid.

| Claim status | Label | Next |
|---|---|---|
| `requested` | Needs approval | staff approve or decline |
| `claimed` | Claimed | the athlete uploads and sends, or gives it back |
| `submitted` | In review | staff accept or send back; files are locked |
| `changes` | Needs changes | the athlete sends again, with the staff note on the card |
| `delivered` | Delivered | final |
| `declined` | Not approved | staff can still approve it |

Rows live in one partition: `ASK#{id}` holds `META`, `CLAIM#{sub}` and
`FILE#{sub}#{fileId}`. Moves are conditional on the current status, so two
people acting at once get a 409, not a lost update.

Files go to their own bucket, `niltv-{stage}-portal-submissions-{account}`, under
`submissions/`. Nothing there reaches the transcoder or the public site. Video,
audio and photos only, 2 GB per file, 10 files per claim. Browsers upload
16 MB parts with short-lived links, and the API checks the bucket's own part
list before a file counts as landed. Picking the same file again carries on
from the parts that arrived. Unfinished uploads clear after 7 days.

Ask descriptions are GitHub-style Markdown (`portal/src/ui/Markdown.tsx`). Raw HTML
never renders. Staff can upload, paste or drop an image: it lands under
`submissions/ask-images/`, the text stores `portal-image:{id}`, and the API returns
short-lived links in `images`, so the bucket stays private.

## Availability

The week is 30-minute rows from 6 AM to midnight (`DAY_TIMES`), slots like
`thu-1730`, in each member's own time zone. `upgradeSlots` reads rows saved in the
older four-block shape.

## Test accounts on dev

One account per role, with sample content, for people testing by hand:

```
cd backend
PORTAL_API_URL=<PortalApiUrl output> npx tsx scripts/portal-test-accounts.ts --support-email someone@niltv.com
```

It is safe to run again, and it prints the sign-ins. `--rotate` issues new
passwords and `--remove` deletes everything it made. Passwords live in SSM at
`/niltv/dev/portal-test-accounts`, never in the repo. The addresses are on
`@niltv.invalid`, so nothing is emailed to them and Forgot password cannot work.
`--support-email` keeps the Help form pointed at a mailbox that exists, because a
bounce would suppress that address for the whole AWS account.

## Test a deployed stage

```
cd backend
PORTAL_API_URL=<PortalApiUrl output> npx tsx scripts/portal-smoke.ts
```

Dev only. It signs up throwaway accounts on `@niltv.invalid`, walks every
surface and access rule, then deletes everything it made.
