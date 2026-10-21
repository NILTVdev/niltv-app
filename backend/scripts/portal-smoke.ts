/**
 * NIL TV Portal end to end on DEV, through the real API with real tokens.
 *
 *   PORTAL_API_URL=https://xxxx.execute-api.us-east-1.amazonaws.com npx tsx scripts/portal-smoke.ts
 *
 * 1. Signs up four throwaway accounts in the dev pool (@niltv.invalid, so the
 *    notifier never emails them): admin, staff, athlete, guest. The admin
 *    row is written directly (the bootstrap path); everyone else is added
 *    through the API the way staff will do it.
 * 2. Walks every surface and checks the access rules: channel membership
 *    from roster fields, staff-only posting, team labels, desks, groups with
 *    a guest, polls, locking, RSVP, availability heatmap, postings with
 *    approval, page change requests, Help, My posts, and instant removal.
 * 3. Deletes every row and account it created. Refuses anything but dev.
 */
import {
  AdminConfirmSignUpCommand,
  AdminDeleteUserCommand,
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
  SignUpCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { DeleteCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

const table = "niltv-dev";
process.env.TABLE_NAME = table;
const USER_POOL_ID = "us-east-1_fxm8vObBQ";
const TEST_CLIENT_ID = "7ninm1g7ro3b9df4mqnhpds05r";
const API = (process.env.PORTAL_API_URL ?? "").replace(/\/$/, "");

const cognito = new CognitoIdentityProviderClient({ region: "us-east-1" });
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

async function mint(key: string, runId: string): Promise<Person> {
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
  const { getDocClient } = await import("../src/lib/db");

  const runId = Date.now().toString(36);
  const people: Person[] = [];
  const created = { convs: new Set<string>(), events: [] as string[], postings: [] as string[], requests: [] as string[], messages: [] as [string, string][] };

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
    const annStaffMsg = (annStaffView.json["messages"] ?? []).find((m: Json) => m["id"] === ann.json["id"]);
    check("staff see who posted", annStaffMsg?.["staffName"] === "Smoke Admin");

    const hide = await call(staff, "POST", `/v1/conversations/ch-sport-womens-basketball/messages/${posted.json["id"]}/hide`, { hidden: true });
    const hiddenView = await call(athlete, "GET", "/v1/conversations/ch-sport-womens-basketball/messages");
    const hiddenMsg = (hiddenView.json["messages"] ?? []).find((m: Json) => m["id"] === posted.json["id"]);
    check("staff hide a message and its text is gone for athletes", hide.status === 200 && hiddenMsg?.["hidden"] === true && hiddenMsg?.["body"] === "");

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
    check("the guest RSVPs", (await call(guest, "POST", `/v1/events/${ev.json["id"]}/action`, { action: "rsvp", status: "going" })).status === 200);
    const athleteEvents = await call(athlete, "GET", "/v1/events");
    check("athlete in the group sees the event", (athleteEvents.json["events"] ?? []).some((e: Json) => e["id"] === ev.json["id"]));

    await call(athlete, "PUT", "/v1/availability", { slots: ["thu-evening", "sat-afternoon"], timezone: "America/New_York" });
    const heat = await call(staff, "GET", `/v1/availability/heatmap?type=group&value=${encodeURIComponent(groupId)}`);
    const thu = (heat.json["cells"] ?? []).find((c: Json) => c["slot"] === "thu-evening");
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
    const db = getDocClient();
    for (const [convId, msgId] of created.messages) {
      await db.send(new DeleteCommand({ TableName: table, Key: { PK: `CONV#${convId}`, SK: `MSG#${msgId}` } }));
    }
    for (const id of created.convs) if (id) await purgePartition(`CONV#${id}`);
    for (const id of created.events) if (id) await purgePartition(`PEVENT#${id}`);
    for (const id of created.postings) if (id) await purgePartition(`POSTING#${id}`);
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
