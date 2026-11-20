/**
 * NIL TV Portal end to end on DEV, through the real API with real tokens.
 *
 *   PORTAL_API_URL=https://xxxx.execute-api.us-east-1.amazonaws.com npx tsx scripts/portal-smoke.ts
 *
 * 1. Signs up throwaway accounts in the dev pool (@niltv.invalid, so the
 *    notifier never emails them): admin, staff, athlete, guest. The admin
 *    row is written directly (the bootstrap path); everyone else is added
 *    through the API the way staff will do it.
 * 2. Walks every surface and checks the access rules: channel membership
 *    from roster fields, staff-only posting, team labels, desks, groups with
 *    a guest, polls, locking, RSVP, availability heatmap, postings with
 *    approval, page change requests, Help, My posts, and instant removal.
 * 3. Deletes every row and account it created. Refuses anything but dev.
 */
import { DeleteObjectCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import {
  AdminConfirmSignUpCommand,
  AdminDeleteUserCommand,
  AdminUpdateUserAttributesCommand,
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
  SignUpCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { DeleteCommand, GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

const table = "niltv-dev";
process.env.TABLE_NAME = table;
const USER_POOL_ID = "us-east-1_fxm8vObBQ";
const TEST_CLIENT_ID = "7ninm1g7ro3b9df4mqnhpds05r";
const API = (process.env.PORTAL_API_URL ?? "").replace(/\/$/, "");

const cognito = new CognitoIdentityProviderClient({ region: "us-east-1" });
const s3 = new S3Client({ region: "us-east-1" });
const SUBMISSIONS_BUCKET = "niltv-dev-portal-submissions-858321320457";
const checks: { name: string; ok: boolean; detail?: string }[] = [];
const check = (name: string, ok: boolean, detail?: string): void => {
  checks.push({ name, ok, ...(detail ? { detail } : {}) });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};

type Json = Record<string, any>;
interface Person {
  key: string;
  email: string;
  password: string;
  sub: string;
  token: string;
}

/** Every throwaway account keeps every topic off. */
const QUIET = { direct: "off", groups: "off", announcements: "off", channels: "off", schedule: "off", postings: "off", previews: true } as const;

async function call(person: Person | undefined, method: string, path: string, body?: unknown): Promise<{ status: number; json: Json }> {
  const res = await fetch(API + path, {
    method,
    headers: {
      "content-type": "application/json",
      ...(person ? { authorization: `Bearer ${person.token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json: Json = {};
  try {
    json = JSON.parse(text) as Json;
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json };
}

async function mint(key: string, runId: string, verified = true): Promise<Person> {
  const email = `portal-${key}-${runId}@niltv.invalid`;
  const password = `Portal-${runId}-Aa1!`;
  const signup = await cognito.send(
    new SignUpCommand({
      ClientId: TEST_CLIENT_ID,
      Username: email,
      Password: password,
      UserAttributes: [
        { Name: "email", Value: email },
        { Name: "name", Value: `Smoke ${key[0]!.toUpperCase()}${key.slice(1)}` },
        { Name: "birthdate", Value: "1999-01-01" },
      ],
    }),
  );
  await cognito.send(new AdminConfirmSignUpCommand({ UserPoolId: USER_POOL_ID, Username: email }));
  // The portal only links verified addresses, and .invalid mail cannot verify itself.
  if (verified) {
    await cognito.send(
      new AdminUpdateUserAttributesCommand({
        UserPoolId: USER_POOL_ID,
        Username: email,
        UserAttributes: [{ Name: "email_verified", Value: "true" }],
      }),
    );
  }
  const auth = await cognito.send(
    new InitiateAuthCommand({
      ClientId: TEST_CLIENT_ID,
      AuthFlow: "USER_PASSWORD_AUTH",
      AuthParameters: { USERNAME: email, PASSWORD: password },
    }),
  );
  const token = auth.AuthenticationResult?.IdToken;
  if (!token || !signup.UserSub) throw new Error(`could not mint ${key}`);
  return { key, email, password, sub: signup.UserSub, token };
}

/** Delete every item in a partition (and with it every GSI mirror). */
async function purgePartition(pk: string): Promise<void> {
  const { getDocClient } = await import("../src/lib/db");
  let startKey: Record<string, unknown> | undefined;
  do {
    const page = await getDocClient().send(
      new QueryCommand({ TableName: table, KeyConditionExpression: "PK = :pk", ExpressionAttributeValues: { ":pk": pk }, ExclusiveStartKey: startKey }),
    );
    for (const item of page.Items ?? []) {
      await getDocClient().send(new DeleteCommand({ TableName: table, Key: { PK: item["PK"], SK: item["SK"] } }));
    }
    startKey = page.LastEvaluatedKey;
  } while (startKey);
}

async function main(): Promise<void> {
  if (!API) throw new Error("set PORTAL_API_URL to the dev PortalApiUrl output");
  if (!API.includes("execute-api") && !API.includes("dev")) throw new Error("dev only");
  const { putMember } = await import("../src/lib/portal/members");
  const { getDocClient, pendingAthleteKey } = await import("../src/lib/db");

  const runId = Date.now().toString(36);
  const pendingId = 900_000_000 + (Date.now() % 1_000_000);
  /** Puts the real settings back; set once the run has swapped them. */
  let restoreSettings: (() => Promise<unknown>) | undefined;
  const people: Person[] = [];
  // This run posts in shared channels. Their counters go back when it ends, or members see
  // an unread count for messages cleanup removed.
  const sharedChannels = await Promise.all(
    ["ch-announcements", "ch-sport-womens-basketball"].map(async (id) => (await getDocClient().send(new GetCommand({ TableName: table, Key: { PK: `CONV#${id}`, SK: "META" } }))).Item),
  );
  const created = { convs: new Set<string>(), events: [] as string[], postings: [] as string[], asks: [] as string[], requests: [] as string[], messages: [] as [string, string][] };

  try {
    const [admin, staff, athlete, guest] = await Promise.all(["admin", "staff", "athlete", "guest"].map((k) => mint(k, runId)));
    people.push(admin!, staff!, athlete!, guest!);
    check("four throwaway accounts minted tokens", true);

    // ── Access gate ──────────────────────────────────────────────────────
    check("no token is refused", (await call(undefined, "GET", "/v1/me")).status === 401);
    const outsider = await call(guest, "GET", "/v1/me");
    check("a site account without portal access gets NOT_MEMBER", outsider.status === 403 && outsider.json["error"] === "NOT_MEMBER");

    await putMember({
      sub: admin!.sub, email: admin!.email, name: "Smoke Admin", role: "admin", status: "active",
      desks: ["content", "support", "payments"], edited: [], createdAt: new Date().toISOString(),
      notify: QUIET,
    });
    // Rewrite the row's prefs in the old on/off shape: stored rows from before cadences must still read.
    await getDocClient().send(
      new UpdateCommand({
        TableName: table,
        Key: { PK: `USER#${admin!.sub}`, SK: "PORTAL" },
        UpdateExpression: "SET notify = :legacy",
        ExpressionAttributeValues: {
          ":legacy": { directMessages: false, groupMessages: true, channelMessages: false, announcements: false, schedule: false, postings: false },
        },
      }),
    );
    const me = await call(admin, "GET", "/v1/me");
    check("bootstrapped admin reads /v1/me", me.status === 200 && me.json["member"]?.["role"] === "admin");
    const legacy = me.json["member"]?.["notify"] ?? {};
    check(
      "old on/off email flags read as cadences",
      legacy["direct"] === "off" && legacy["groups"] === "now" && legacy["channels"] === "off" && legacy["previews"] === true,
      JSON.stringify(legacy),
    );
    await call(admin, "PATCH", "/v1/me", { notify: QUIET });
    const settingsNow = await call(admin, "GET", "/v1/settings");
    // Help and page change requests always email. During a run that mail goes nowhere.
    const realSettings = settingsNow.json;
    restoreSettings = () => call(admin, "PUT", "/v1/settings", realSettings);
    await call(admin, "PUT", "/v1/settings", {
      ...realSettings,
      supportEmail: "smoke@niltv.invalid",
      deskEmails: { content: ["smoke@niltv.invalid"], support: ["smoke@niltv.invalid"], payments: ["smoke@niltv.invalid"] },
    });
    const reach = me.json["notifications"] ?? {};
    check(
      "/v1/me reports the Settings notification switches",
      typeof settingsNow.json["activityEmails"] === "boolean" &&
        reach["activityEmails"] === settingsNow.json["activityEmails"] &&
        reach["webPush"] === settingsNow.json["webPush"],
      JSON.stringify(reach),
    );

    // ── Adding people through the API ────────────────────────────────────
    const add = (who: Person, body: Json) => call(admin, "POST", "/v1/members", { email: who.email, ...body });
    check("admin adds staff", (await add(staff!, { role: "staff", desks: ["content", "support"] })).status === 201);
    check(
      "admin adds an athlete with campus and sport",
      (await add(athlete!, { role: "athlete", campus: "truebluetv", sport: "Women's Basketball" })).status === 201,
    );
    const noAccount = await call(admin, "POST", "/v1/members", { email: `nobody-${runId}@niltv.invalid`, role: "guest" });
    check("adding an email with no site account says so", noAccount.status === 404 && noAccount.json["error"] === "NO_ACCOUNT");
    check("staff adds a guest", (await call(staff, "POST", "/v1/members", { email: guest!.email, role: "guest", note: "Gaming partner" })).status === 201);
    check("staff cannot add staff", (await call(staff, "POST", "/v1/members", { email: `x-${runId}@niltv.invalid`, role: "staff" })).status === 403);
    const unproven = await mint("unproven", runId, false);
    people.push(unproven);
    const hijack = await call(admin, "POST", "/v1/members", { email: unproven.email, role: "staff" });
    check("an account that never verified its email gets no access", hijack.status === 404 && hijack.json["error"] === "NO_ACCOUNT");

    // ── Accepted athletes with no account ────────────────────────────────
    await getDocClient().send(
      new PutCommand({
        TableName: table,
        Item: {
          ...pendingAthleteKey(pendingId),
          applicationId: pendingId,
          email: `pending-${runId}@niltv.invalid`,
          name: "Smoke Pending",
          firstSeenAt: new Date().toISOString(),
        },
      }),
    );
    const pendingList = await call(staff, "GET", "/v1/athletes/pending");
    check(
      "staff see accepted athletes with no account",
      pendingList.status === 200 && (pendingList.json["pending"] ?? []).some((p: Json) => p["applicationId"] === pendingId),
    );
    check("athletes cannot see that list", (await call(athlete, "GET", "/v1/athletes/pending")).status === 403);
    const invitePath = `/v1/athletes/pending/${pendingId}/invite`;
    check("staff cannot send an invite", (await call(staff, "POST", invitePath)).status === 403);
    const invited = await call(admin, "POST", invitePath);
    check("an admin sends an invite", invited.status === 200 && typeof invited.json["invitedAt"] === "string");
    check("a second invite the same day is refused", (await call(admin, "POST", invitePath)).status === 409);
    check("an invite for nobody is not found", (await call(admin, "POST", "/v1/athletes/pending/1/invite")).status === 404);
    check("staff cannot link an athlete", (await call(staff, "POST", `/v1/athletes/pending/${pendingId}/link`, { email: athlete!.email })).status === 403);
    const badLink = await call(admin, "POST", `/v1/athletes/pending/${pendingId}/link`, { email: unproven.email });
    check("an unproven account cannot be linked", badLink.status === 404 && badLink.json["error"] === "NO_ACCOUNT");
    const staffLink = await call(admin, "POST", `/v1/athletes/pending/${pendingId}/link`, { email: staff!.email });
    check("a staff account cannot be linked as an athlete", staffLink.status === 409);
    const linked = await call(admin, "POST", `/v1/athletes/pending/${pendingId}/link`, { email: athlete!.email });
    const afterLink = await call(staff, "GET", "/v1/athletes/pending");
    check(
      "linking connects the athlete and clears the row",
      linked.status === 200 &&
        linked.json["applicationId"] === pendingId &&
        !(afterLink.json["pending"] ?? []).some((p: Json) => p["applicationId"] === pendingId),
    );
    for (const p of [staff!, athlete!, guest!]) await call(p, "PATCH", "/v1/me", { notify: QUIET });

    // ── Push devices ─────────────────────────────────────────────────────
    const fakeKeys = { p256dh: `B${"A".repeat(86)}`, auth: "AAAAAAAAAAAAAAAAAAAAAA" };
    const badHost = await call(athlete, "POST", "/v1/push", { endpoint: "https://example.com/push/1", keys: fakeKeys });
    check("push refuses an endpoint that is not a browser push service", badHost.status === 400);
    const fcm = `https://fcm.googleapis.com/fcm/send/smoke-${runId}`;
    const sub1 = await call(athlete, "POST", "/v1/push", { endpoint: fcm, keys: fakeKeys });
    if (settingsNow.json["webPush"] && reach["vapidPublicKey"]) {
      const listed = await call(athlete, "GET", "/v1/push");
      check("a push device registers and lists", sub1.status === 201 && (listed.json["devices"] ?? []).length === 1);
      await call(athlete, "POST", "/v1/push/remove", { endpoint: fcm });
      check("the device unsubscribes", ((await call(athlete, "GET", "/v1/push")).json["devices"] ?? []).length === 0);
    } else {
      check("push subscriptions are refused while push is off", sub1.status === 409);
    }

    // ── Channels ─────────────────────────────────────────────────────────
    const athleteInbox = await call(athlete, "GET", "/v1/inbox");
    const ids = (athleteInbox.json["conversations"] ?? []).map((c: Json) => c["id"]);
    check(
      "athlete joined announcements, everyone, campus and sport channels",
      ["ch-announcements", "ch-everyone", "ch-campus-truebluetv", "ch-sport-womens-basketball"].every((id) => ids.includes(id)),
      ids.join(","),
    );
    const guestInbox = await call(guest, "GET", "/v1/inbox");
    check("guest sees no channels", (guestInbox.json["conversations"] ?? []).every((c: Json) => c["kind"] !== "channel"));
    check("guest cannot read a channel", (await call(guest, "GET", "/v1/conversations/ch-everyone/messages")).status === 404);

    const blocked = await call(athlete, "POST", "/v1/conversations/ch-announcements/messages", { clientMsgId: `smoke-${runId}-a`, body: "hi" });
    check("athlete cannot post in Announcements", blocked.status === 403 && blocked.json["error"] === "STAFF_ONLY");
    const posted = await call(athlete, "POST", "/v1/conversations/ch-sport-womens-basketball/messages", {
      clientMsgId: `smoke-${runId}-b`, body: "Smoke test, ignore.", important: true,
    });
    check("athlete posts in their sport channel, and cannot flag it important", posted.status === 201 && posted.json["important"] === false);
    if (posted.json["id"]) created.messages.push(["ch-sport-womens-basketball", posted.json["id"]]);
    const again = await call(athlete, "POST", "/v1/conversations/ch-sport-womens-basketball/messages", { clientMsgId: `smoke-${runId}-b`, body: "Smoke test, ignore." });
    check("a retried send lands once", again.status === 200 && again.json["duplicate"] === true);

    const ann = await call(admin, "POST", "/v1/conversations/ch-announcements/messages", {
      clientMsgId: `smoke-${runId}-c`, body: "Smoke test announcement, ignore.", important: true,
    });
    check("admin posts in Announcements, flagged important", ann.status === 201 && ann.json["important"] === true);
    if (ann.json["id"]) created.messages.push(["ch-announcements", ann.json["id"]]);
    const annView = await call(athlete, "GET", "/v1/conversations/ch-announcements/messages");
    const annMsg = (annView.json["messages"] ?? []).find((m: Json) => m["id"] === ann.json["id"]);
    check("athletes see staff posts as NIL TV Team, without the staff name", annMsg?.["authorName"] === "NIL TV Team" && annMsg?.["staffName"] === undefined);
    const annStaffView = await call(staff, "GET", "/v1/conversations/ch-announcements/messages");
    check("a thread reports its newest position, so opening it clears the count", annStaffView.json["lastSeq"] > 0);
    const annStaffMsg = (annStaffView.json["messages"] ?? []).find((m: Json) => m["id"] === ann.json["id"]);
    check("staff see who posted", annStaffMsg?.["staffName"] === "Smoke Admin");

    const hide = await call(staff, "POST", `/v1/conversations/ch-sport-womens-basketball/messages/${posted.json["id"]}/hide`, { hidden: true });
    const hiddenView = await call(athlete, "GET", "/v1/conversations/ch-sport-womens-basketball/messages");
    const hiddenMsg = (hiddenView.json["messages"] ?? []).find((m: Json) => m["id"] === posted.json["id"]);
    check("staff hide a message and its text is gone for athletes", hide.status === 200 && hiddenMsg?.["hidden"] === true && hiddenMsg?.["body"] === "");
    const hiddenRow = ((await call(athlete, "GET", "/v1/inbox")).json["conversations"] ?? []).find((c: Json) => c["id"] === "ch-sport-womens-basketball");
    check("the inbox preview drops a hidden newest message", hiddenRow?.["lastPreview"] !== posted.json["body"]);

    // ── Desks ────────────────────────────────────────────────────────────
    const desk = await call(athlete, "POST", "/v1/desks", { desk: "support" });
    const deskId = desk.json["id"] as string;
    created.convs.add(deskId);
    check("athlete opens the Athlete support desk", desk.status === 200 && desk.json["title"] === "Athlete support");
    const deskMsg = await call(athlete, "POST", `/v1/conversations/${deskId}/messages`, {
      clientMsgId: `smoke-${runId}-d`, body: "Smoke test desk message.", mentions: [staff!.sub],
    });
    check("desk messages carry no @mentions", deskMsg.status === 201 && (deskMsg.json["mentions"] ?? []).length === 0);
    const staffInbox = await call(staff, "GET", "/v1/inbox");
    const deskRow = (staffInbox.json["conversations"] ?? []).find((c: Json) => c["id"] === deskId);
    check("staff on the desk see the thread by the athlete's name, unread", deskRow?.["title"] === "Smoke Athlete" && deskRow?.["unread"] >= 1);
    const reply = await call(staff, "POST", `/v1/conversations/${deskId}/messages`, { clientMsgId: `smoke-${runId}-e`, body: "Smoke test reply." });
    const deskView = await call(athlete, "GET", `/v1/conversations/${deskId}/messages`);
    const replyMsg = (deskView.json["messages"] ?? []).find((m: Json) => m["id"] === reply.json["id"]);
    check("the athlete sees the reply signed Athlete support", replyMsg?.["authorName"] === "Athlete support");
    const payDesk = await call(athlete, "POST", "/v1/desks", { desk: "payments" });
    created.convs.add(payDesk.json["id"]);
    check("staff cannot read the Payments desk", (await call(staff, "GET", `/v1/conversations/${payDesk.json["id"]}`)).status === 404);
    check("guests cannot open the Payments desk", (await call(guest, "POST", "/v1/desks", { desk: "payments" })).status === 403);

    // ── Groups ───────────────────────────────────────────────────────────
    check("staff cannot create groups", (await call(staff, "POST", "/v1/groups", { title: "x", memberSubs: [] })).status === 403);
    const group = await call(admin, "POST", "/v1/groups", { title: `Smoke crew ${runId}`, about: "Smoke test", memberSubs: [athlete!.sub, guest!.sub] });
    const groupId = group.json["id"] as string;
    created.convs.add(groupId);
    check("admin creates a group with an athlete and a guest", group.status === 201 && group.json["members"]?.length === 2);
    const guestInbox2 = await call(guest, "GET", "/v1/inbox");
    check("the guest sees the group", (guestInbox2.json["conversations"] ?? []).some((c: Json) => c["id"] === groupId));

    // ── @mentions ────────────────────────────────────────────────────────
    const guestPeople = await call(guest, "GET", `/v1/conversations/${groupId}/people?q=smoke`);
    const guestNames = (guestPeople.json["people"] ?? []).map((p: Json) => p["sub"]);
    check("the @ list offers group members and hides staff from non-staff", guestNames.includes(athlete!.sub) && !guestNames.includes(staff!.sub));
    const adminPeople = await call(admin, "GET", `/v1/conversations/${groupId}/people?q=smoke`);
    check("staff see staff in the @ list", (adminPeople.json["people"] ?? []).some((p: Json) => p["sub"] === staff!.sub));
    const outsiderSub = `not-a-member-${runId}`;
    const mention = await call(guest, "POST", `/v1/conversations/${groupId}/messages`, {
      clientMsgId: `smoke-${runId}-m`, body: "@Smoke Athlete smoke test mention.", mentions: [athlete!.sub, outsiderSub, guest!.sub],
    });
    check(
      "a mention keeps only people who can read the thread",
      mention.status === 201 && JSON.stringify(mention.json["mentions"]) === JSON.stringify([athlete!.sub]),
      JSON.stringify(mention.json["mentions"]),
    );
    const mentionedRow = ((await call(athlete, "GET", "/v1/inbox")).json["conversations"] ?? []).find((c: Json) => c["id"] === groupId);
    check("the mentioned athlete's inbox flags the group", mentionedRow?.["mentioned"] === true && mentionedRow?.["unread"] >= 1);
    await call(athlete, "POST", `/v1/conversations/${groupId}/read`, { seq: mention.json["seq"] });
    const readRow = ((await call(athlete, "GET", "/v1/inbox")).json["conversations"] ?? []).find((c: Json) => c["id"] === groupId);
    check("reading the thread clears the mention flag", readRow?.["mentioned"] === false);

    // ── Schedule ─────────────────────────────────────────────────────────
    const t1 = new Date(Date.now() + 3 * 864e5).toISOString();
    const t2 = new Date(Date.now() + 4 * 864e5).toISOString();
    const ev = await call(staff, "POST", "/v1/events", {
      title: `Smoke stream ${runId}`, kind: "stream", audience: { type: "group", convId: groupId },
      options: [{ startsAt: t1 }, { startsAt: t2 }],
    });
    created.events.push(ev.json["id"]);
    check("staff create a time poll for the group", ev.status === 201 && ev.json["status"] === "poll" && ev.json["invitedCount"] === 2);
    const guestEvents = await call(guest, "GET", "/v1/events");
    const seen = (guestEvents.json["events"] ?? []).find((e: Json) => e["id"] === ev.json["id"]);
    check("the guest sees the poll", Boolean(seen));
    const opt = ev.json["options"]?.[1]?.["id"];
    await call(guest, "POST", `/v1/events/${ev.json["id"]}/action`, { action: "vote", optionIds: [opt] });
    const staffEvents = await call(staff, "GET", "/v1/events");
    const staffEv = (staffEvents.json["events"] ?? []).find((e: Json) => e["id"] === ev.json["id"]);
    const votesForOpt = staffEv?.["votes"]?.find((v: Json) => v["optionId"] === opt)?.["people"] ?? [];
    check("staff see who picked which time", votesForOpt.some((p: Json) => p["sub"] === guest!.sub));
    check("guests cannot lock times", (await call(guest, "POST", `/v1/events/${ev.json["id"]}/action`, { action: "lock", optionId: opt })).status === 403);
    const lock = await call(staff, "POST", `/v1/events/${ev.json["id"]}/action`, { action: "lock", optionId: opt });
    check("staff lock the time", lock.status === 200 && lock.json["status"] === "set");
    const relock = await call(staff, "POST", `/v1/events/${ev.json["id"]}/action`, { action: "lock", optionId: opt });
    check("a time cannot be locked twice", relock.status === 409);
    const afterLock = (await call(guest, "GET", "/v1/events")).json["events"]?.find((e: Json) => e["id"] === ev.json["id"]);
    check("people who picked the locked time count as going", afterLock?.["myRsvp"] === "going");
    check("the guest RSVPs", (await call(guest, "POST", `/v1/events/${ev.json["id"]}/action`, { action: "rsvp", status: "maybe" })).status === 200);
    const reopen = await call(staff, "POST", `/v1/events/${ev.json["id"]}/action`, { action: "reopen" });
    const afterReopen = (await call(guest, "GET", "/v1/events")).json["events"]?.find((e: Json) => e["id"] === ev.json["id"]);
    check("reopening goes back to picking and clears replies", reopen.status === 200 && afterReopen?.["status"] === "poll" && !afterReopen?.["myRsvp"] && afterReopen?.["myAnswered"] === true);
    await call(athlete, "POST", `/v1/events/${ev.json["id"]}/action`, { action: "vote", optionIds: [] });
    const athleteView = (await call(athlete, "GET", "/v1/events")).json["events"]?.find((e: Json) => e["id"] === ev.json["id"]);
    const staffView = (await call(staff, "GET", "/v1/events")).json["events"]?.find((e: Json) => e["id"] === ev.json["id"]);
    check("none of these work counts as an answer", athleteView?.["myAnswered"] === true);
    check("staff see who said none work", (staffView?.["noneWork"] ?? []).some((p: Json) => p["sub"] === athlete!.sub));
    check("nobody is left waiting once all have answered", staffView?.["waitingCount"] === 0);
    check("members never see who has not answered", athleteView?.["waiting"] === undefined);
    check("guests cannot send a reminder", (await call(guest, "POST", `/v1/events/${ev.json["id"]}/action`, { action: "remind" })).status === 403);
    const edited = await call(staff, "PUT", `/v1/events/${ev.json["id"]}`, {
      title: `Smoke stream ${runId}`, kind: "stream", audience: { type: "group", convId: groupId },
      options: [{ startsAt: t1 }, { startsAt: t2 }, { startsAt: new Date(Date.now() + 5 * 864e5).toISOString() }],
    });
    const asked = (await call(guest, "GET", "/v1/events")).json["events"]?.find((e: Json) => e["id"] === ev.json["id"]);
    check("adding a time asks everyone again and keeps their picks", edited.status === 200 && asked?.["myAnswered"] === false && asked?.["myVotes"]?.includes(opt));
    await call(staff, "POST", `/v1/events/${ev.json["id"]}/action`, { action: "lock", optionId: opt });
    await call(staff, "POST", `/v1/events/${ev.json["id"]}/action`, { action: "cancel" });
    check("a cancelled event cannot be locked", (await call(staff, "POST", `/v1/events/${ev.json["id"]}/action`, { action: "lock", optionId: opt })).status === 409);
    const athleteEvents = await call(athlete, "GET", "/v1/events");
    check("athlete in the group sees the event", (athleteEvents.json["events"] ?? []).some((e: Json) => e["id"] === ev.json["id"]));

    await call(athlete, "PUT", "/v1/availability", { slots: ["thu-1730", "sat-1300"], timezone: "America/New_York" });
    const heat = await call(staff, "GET", `/v1/availability/heatmap?type=group&value=${encodeURIComponent(groupId)}`);
    const thu = (heat.json["cells"] ?? []).find((c: Json) => c["slot"] === "thu-1730");
    check("the heatmap counts the athlete's availability", heat.status === 200 && thu?.["count"] === 1 && heat.json["invited"] === 2);
    check("athletes cannot read the heatmap", (await call(athlete, "GET", "/v1/availability/heatmap")).status === 403);

    // ── Postings ─────────────────────────────────────────────────────────
    const posting = await call(staff, "POST", "/v1/postings", { title: `Smoke posting ${runId}`, about: "Smoke test", details: "Ignore.", requiresApproval: true, status: "closed" });
    created.postings.push(posting.json["id"]);
    await call(staff, "PUT", `/v1/postings/${posting.json["id"]}`, { title: `Smoke posting ${runId}`, about: "Smoke test", details: "Ignore.", requiresApproval: true, status: "open" });
    check("guests cannot see postings", (await call(guest, "GET", "/v1/postings")).status === 403);
    check("the athlete marks interest", (await call(athlete, "POST", `/v1/postings/${posting.json["id"]}/action`, { action: "interest", interested: true })).status === 200);
    const decide = await call(staff, "POST", `/v1/postings/${posting.json["id"]}/action`, { action: "decide", personSub: athlete!.sub, status: "approved" });
    const athletePostings = await call(athlete, "GET", "/v1/postings");
    const mine = (athletePostings.json["postings"] ?? []).find((p: Json) => p["id"] === posting.json["id"]);
    check("staff approve and the athlete sees it", decide.status === 200 && mine?.["myInterest"] === "approved");

    // ── Content Hub ──────────────────────────────────────────────────────
    const askBody = { title: `Smoke ask ${runId}`, format: "short", description: "Smoke test.", audience: { type: "everyone" }, requiresApproval: true, status: "open" };
    const ask = await call(staff, "POST", "/v1/asks", askBody);
    created.asks.push(ask.json["id"]);
    const askId = ask.json["id"];
    check("staff post an ask", ask.status === 201);
    check("athletes cannot post an ask", (await call(athlete, "POST", "/v1/asks", askBody)).status === 403);
    check("guests cannot see the Hub", (await call(guest, "GET", "/v1/asks")).status === 403);
    const otherSport = await call(staff, "POST", "/v1/asks", { ...askBody, title: `Smoke other ${runId}`, audience: { type: "sport", sport: "Golf" } });
    created.asks.push(otherSport.json["id"]);
    const myAsks = async (): Promise<Json[]> => (await call(athlete, "GET", "/v1/asks")).json["asks"] ?? [];
    const myAsk = async (): Promise<Json | undefined> => (await myAsks()).find((a) => a["id"] === askId);
    check("an ask for another sport stays hidden", !(await myAsks()).some((a) => a["id"] === otherSport.json["id"]));
    check("an athlete cannot claim an ask that is not for them", (await call(athlete, "POST", `/v1/asks/${otherSport.json["id"]}/action`, { action: "claim" })).status === 403);
    const act = (who: typeof staff, body: Json) => call(who, "POST", `/v1/asks/${askId}/action`, body);
    check("the athlete requests the claim", (await act(athlete, { action: "claim" })).status === 200 && (await myAsk())?.["myClaim"]?.["status"] === "requested");
    const uploadBody = { name: "smoke clip.mp4", size: 11, type: "video/mp4" };
    check("no uploads before approval", (await call(athlete, "POST", `/v1/asks/${askId}/uploads`, uploadBody)).status === 403);
    check("athletes cannot approve themselves", (await act(athlete, { action: "decide", personSub: athlete!.sub, approved: true })).status === 403);
    check("staff approve the claim", (await act(staff, { action: "decide", personSub: athlete!.sub, approved: true })).status === 200 && (await myAsk())?.["myClaim"]?.["status"] === "claimed");
    check("a stale decision is refused", (await act(staff, { action: "decide", personSub: athlete!.sub, approved: false })).status === 409);
    check("nothing to submit yet", (await act(athlete, { action: "submit" })).status === 400);
    check("only video, audio and photos", (await call(athlete, "POST", `/v1/asks/${askId}/uploads`, { ...uploadBody, type: "text/html" })).status === 400);
    check("nothing over 2 GB", (await call(athlete, "POST", `/v1/asks/${askId}/uploads`, { ...uploadBody, size: 2 * 1024 ** 3 + 1 })).status === 400);
    const started = await call(athlete, "POST", `/v1/asks/${askId}/uploads`, uploadBody);
    const fileId = started.json["fileId"];
    check("the upload starts", started.status === 201 && Boolean(fileId));
    check("a part past the end gets no link", (await call(athlete, "POST", `/v1/asks/${askId}/uploads/${fileId}/part`, { partNumber: 2 })).status === 400);
    check("an unfinished file cannot land", (await call(athlete, "POST", `/v1/asks/${askId}/uploads/${fileId}/complete`)).status === 400);
    const link = await call(athlete, "POST", `/v1/asks/${askId}/uploads/${fileId}/part`, { partNumber: 1 });
    const put = await fetch(link.json["url"], { method: "PUT", body: "smoke bytes" });
    check("the part reaches the bucket", put.ok);
    const resumed = await call(athlete, "POST", `/v1/asks/${askId}/uploads`, uploadBody);
    check("picking the same file again carries on", resumed.status === 200 && resumed.json["fileId"] === fileId && resumed.json["doneParts"]?.[0] === 1);
    check("the file lands", (await call(athlete, "POST", `/v1/asks/${askId}/uploads/${fileId}/complete`)).status === 200);
    check("the athlete sees the file", (await myAsk())?.["myClaim"]?.["files"]?.[0]?.["id"] === fileId);
    const preflight = await fetch(link.json["url"], { method: "OPTIONS", headers: { origin: "https://portal-dev.niltv.com", "access-control-request-method": "PUT" } });
    check("the bucket lets the portal upload from a browser", preflight.ok && preflight.headers.get("access-control-allow-origin") === "https://portal-dev.niltv.com");
    const otherSite = await fetch(link.json["url"], { method: "OPTIONS", headers: { origin: "https://example.com", "access-control-request-method": "PUT" } });
    check("the bucket refuses other sites", !otherSite.ok);
    const bigSize = 16 * 1024 ** 2 + 5;
    const big = await call(athlete, "POST", `/v1/asks/${askId}/uploads`, { name: "two parts.mov", size: bigSize, type: "video/quicktime" });
    for (const [partNumber, bytes] of [[1, 16 * 1024 ** 2], [2, 5]] as const) {
      const part = await call(athlete, "POST", `/v1/asks/${askId}/uploads/${big.json["fileId"]}/part`, { partNumber });
      await fetch(part.json["url"], { method: "PUT", body: new Uint8Array(bytes) });
    }
    const bigDone = await call(athlete, "POST", `/v1/asks/${askId}/uploads/${big.json["fileId"]}/complete`);
    check("a file in two parts lands whole", bigDone.status === 200 && bigDone.json["size"] === bigSize);
    check("a landed file can be removed", (await call(athlete, "DELETE", `/v1/asks/${askId}/uploads/${big.json["fileId"]}`)).status === 200 && (await myAsk())?.["myClaim"]?.["files"]?.length === 1);
    check("the athlete sends it for review", (await act(athlete, { action: "submit", note: "Smoke note" })).status === 200);
    check("files lock during review", (await call(athlete, "DELETE", `/v1/asks/${askId}/uploads/${fileId}`)).status === 403);
    check("a claim in review cannot be given back", (await act(athlete, { action: "release" })).status === 409);
    const filePath = `/v1/asks/${askId}/files/${athlete!.sub}/${fileId}`;
    check("guests cannot open a file", (await call(guest, "GET", filePath)).status === 403);
    const opened = await call(staff, "GET", filePath);
    check("staff open the file", opened.status === 200 && (await (await fetch(opened.json["url"])).text()) === "smoke bytes");
    check("Needs changes takes a note", (await act(staff, { action: "review", personSub: athlete!.sub, outcome: "changes" })).status === 400);
    check("staff send it back", (await act(staff, { action: "review", personSub: athlete!.sub, outcome: "changes", note: "Smoke fix" })).status === 200);
    const sentBack = (await myAsk())?.["myClaim"];
    check("the athlete sees what to change", sentBack?.["status"] === "changes" && sentBack?.["reviewNote"] === "Smoke fix");
    check("the athlete sends it again", (await act(athlete, { action: "submit" })).status === 200);
    check("staff accept it", (await act(staff, { action: "review", personSub: athlete!.sub, outcome: "delivered" })).status === 200 && (await myAsk())?.["myClaim"]?.["status"] === "delivered");
    // Images in a description.
    check("athletes cannot upload ask images", (await call(athlete, "POST", "/v1/asks/images", { type: "image/png", size: 5 })).status === 403);
    check("only photo types", (await call(staff, "POST", "/v1/asks/images", { type: "image/svg+xml", size: 5 })).status === 400);
    const image = await call(staff, "POST", "/v1/asks/images", { type: "image/png", size: 5 });
    const imagePut = await fetch(image.json["uploadUrl"], { method: "PUT", headers: { "content-type": "image/png" }, body: "smoke" });
    check("staff upload an image", imagePut.ok);
    await call(staff, "PUT", `/v1/asks/${askId}`, { ...askBody, description: `Look ![shot](portal-image:${image.json["id"]})` });
    const imageUrl = (await myAsk())?.["images"]?.[image.json["id"]];
    check("the athlete gets a working image link", Boolean(imageUrl) && (await (await fetch(imageUrl)).text()) === "smoke");
    await s3.send(new DeleteObjectCommand({ Bucket: SUBMISSIONS_BUCKET, Key: `submissions/ask-images/${image.json["id"]}` }));
    const staffAsks = (await call(staff, "GET", "/v1/asks")).json["asks"] ?? [];
    const staffClaim = staffAsks.find((a: Json) => a["id"] === askId)?.["claims"]?.[0];
    check("staff see the claim and its files", staffClaim?.["status"] === "delivered" && staffClaim?.["files"]?.length === 1);

    // ── Requests, Help, My posts ─────────────────────────────────────────
    const req = await call(athlete, "POST", "/v1/requests", { body: "Smoke test: please ignore this request." });
    created.requests.push(req.json["id"]);
    check("the athlete files a page change request", req.status === 201);
    check("guests cannot file page change requests", (await call(guest, "POST", "/v1/requests", { body: "Smoke test request." })).status === 403);
    const done = await call(staff, "PATCH", `/v1/requests/${req.json["id"]}`, { status: "done", staffNote: "Smoke" });
    check("staff close the request", done.status === 200 && done.json["resolvedByName"] === "Smoke Staff");
    const myPosts = await call(athlete, "GET", "/v1/my-posts");
    check("My posts answers for an unlinked athlete", myPosts.status === 200 && myPosts.json["linked"] === false);
    check("staff cannot change settings", (await call(staff, "PUT", "/v1/settings", {})).status === 403);

    // ── Removal is instant ───────────────────────────────────────────────
    const disable = await call(admin, "PATCH", `/v1/members/${athlete!.sub}`, { status: "disabled" });
    const after = await call(athlete, "GET", "/v1/inbox");
    check("a disabled athlete is locked out on the next request", disable.status === 200 && after.status === 403);
    check("an admin cannot change their own role", (await call(admin, "PATCH", `/v1/members/${admin!.sub}`, { role: "staff" })).status === 403);
  } finally {
    // ── Cleanup ──────────────────────────────────────────────────────────
    await restoreSettings?.();
    const db = getDocClient();
    await db.send(new DeleteCommand({ TableName: table, Key: pendingAthleteKey(pendingId) }));
    for (const [convId, msgId] of created.messages) {
      await db.send(new DeleteCommand({ TableName: table, Key: { PK: `CONV#${convId}`, SK: `MSG#${msgId}` } }));
    }
    for (const id of created.convs) if (id) await purgePartition(`CONV#${id}`);
    for (const id of created.events) if (id) await purgePartition(`PEVENT#${id}`);
    for (const id of created.postings) if (id) await purgePartition(`POSTING#${id}`);
    for (const id of created.asks) {
      if (!id) continue;
      await purgePartition(`ASK#${id}`);
      const left = await s3.send(new ListObjectsV2Command({ Bucket: SUBMISSIONS_BUCKET, Prefix: `submissions/${id}/` }));
      for (const o of left.Contents ?? []) await s3.send(new DeleteObjectCommand({ Bucket: SUBMISSIONS_BUCKET, Key: o.Key }));
    }
    for (const id of created.requests) if (id) await purgePartition(`PREQ#${id}`);
    for (const p of people) {
      await purgePartition(`USER#${p.sub}`);
      await cognito.send(new AdminDeleteUserCommand({ UserPoolId: USER_POOL_ID, Username: p.email })).catch(() => undefined);
    }
    // Retry guards left in the shared channels by this run.
    for (const convId of ["ch-announcements", "ch-sport-womens-basketball"]) {
      const out = await db.send(
        new QueryCommand({
          TableName: table,
          KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
          ExpressionAttributeValues: { ":pk": `CONV#${convId}`, ":sk": `CMID#smoke-${runId}` },
        }),
      );
      for (const item of out.Items ?? []) await db.send(new DeleteCommand({ TableName: table, Key: { PK: item["PK"], SK: item["SK"] } }));
    }
    for (const item of sharedChannels) if (item) await db.send(new PutCommand({ TableName: table, Item: item }));
    console.log("cleanup done");
  }

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} passed`);
  if (failed.length > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
