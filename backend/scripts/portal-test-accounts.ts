/**
 * Shareable test accounts for portal-dev: one per role, plus sample content so
 * every tier has something to look at. Dev only: the pool and table are fixed.
 *
 *   PORTAL_API_URL=<dev PortalApiUrl> npx tsx scripts/portal-test-accounts.ts --support-email someone@niltv.com
 *     Creates whatever is missing and prints the sign-ins. Safe to run again.
 *   ... --rotate   new passwords for every account (the old ones stop working)
 *   ... --remove   deletes the accounts and everything this script seeded
 *
 * The addresses are on @niltv.invalid, which the portal skips, so nothing is
 * emailed and nothing can bounce. It also means Forgot password cannot work
 * for them. Passwords live in SSM as a SecureString, never in the repo.
 *
 * --support-email points the Help form at a mailbox that exists, so a test on
 * dev cannot bounce and get an address suppressed for the whole AWS account.
 */
import { randomBytes } from "node:crypto";
import {
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminGetUserCommand,
  AdminSetUserPasswordCommand,
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { DeleteParameterCommand, GetParameterCommand, PutParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { DeleteCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { type Desk, PortalMember, type PortalRole } from "@niltv/types";

const table = "niltv-dev";
process.env.TABLE_NAME = table;
const USER_POOL_ID = "us-east-1_fxm8vObBQ";
const TEST_CLIENT_ID = "7ninm1g7ro3b9df4mqnhpds05r";
const API = (process.env.PORTAL_API_URL ?? "").replace(/\/$/, "");
const STATE_PARAM = "/niltv/dev/portal-test-accounts";

const WAITING_SUB = "test-waiting-athlete";
const PENDING_ID = 900_000_001;

const cognito = new CognitoIdentityProviderClient({ region: "us-east-1" });
const ssm = new SSMClient({ region: "us-east-1" });

const args = process.argv.slice(2);
const flag = (name: string): boolean => args.includes(`--${name}`);
const arg = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

interface Account {
  key: string;
  name: string;
  role: PortalRole;
  desks?: Desk[];
  extra?: Partial<PortalMember>;
}

const ACCOUNTS: Account[] = [
  { key: "admin", name: "Test Admin", role: "admin", desks: ["content", "support", "payments"] },
  { key: "staff", name: "Test Staff", role: "staff", desks: ["content", "support"] },
  {
    key: "athlete",
    name: "Test Athlete",
    role: "athlete",
    extra: { campus: "truebluetv", school: "Duke", sport: "Women's Basketball", year: "Senior", stripe: "complete" },
  },
  { key: "guest", name: "Test Guest", role: "guest", extra: { note: "Test partner" } },
];

const emailOf = (key: string): string => `${key}.test@niltv.invalid`;
const newPassword = (): string => `Test-${randomBytes(6).toString("hex")}-Aa1`;

interface State {
  passwords: Record<string, string>;
  seeded?: { convs: string[]; events: string[]; postings: string[] };
}

async function readState(): Promise<State> {
  try {
    const out = await ssm.send(new GetParameterCommand({ Name: STATE_PARAM, WithDecryption: true }));
    return JSON.parse(out.Parameter?.Value ?? "{}") as State;
  } catch (err) {
    if ((err as { name?: string }).name === "ParameterNotFound") return { passwords: {} };
    throw err;
  }
}

const saveState = (state: State) =>
  ssm.send(new PutParameterCommand({ Name: STATE_PARAM, Type: "SecureString", Overwrite: true, Value: JSON.stringify(state) }));

async function subOf(email: string): Promise<string | undefined> {
  try {
    const user = await cognito.send(new AdminGetUserCommand({ UserPoolId: USER_POOL_ID, Username: email }));
    return user.UserAttributes?.find((a) => a.Name === "sub")?.Value;
  } catch (err) {
    if ((err as { name?: string }).name === "UserNotFoundException") return undefined;
    throw err;
  }
}

/** Created directly and confirmed, so no code email goes out. */
async function ensureUser(account: Account, password: string): Promise<string> {
  const email = emailOf(account.key);
  let sub = await subOf(email);
  if (!sub) {
    const created = await cognito.send(
      new AdminCreateUserCommand({
        UserPoolId: USER_POOL_ID,
        Username: email,
        MessageAction: "SUPPRESS",
        UserAttributes: [
          { Name: "email", Value: email },
          { Name: "email_verified", Value: "true" },
          { Name: "name", Value: account.name },
          { Name: "birthdate", Value: "1999-01-01" },
        ],
      }),
    );
    sub = created.User?.Attributes?.find((a) => a.Name === "sub")?.Value;
    if (!sub) throw new Error(`no sub for ${email}`);
  }
  await cognito.send(
    new AdminSetUserPasswordCommand({ UserPoolId: USER_POOL_ID, Username: email, Password: password, Permanent: true }),
  );
  return sub;
}

async function tokenFor(key: string, password: string): Promise<string> {
  const auth = await cognito.send(
    new InitiateAuthCommand({
      ClientId: TEST_CLIENT_ID,
      AuthFlow: "USER_PASSWORD_AUTH",
      AuthParameters: { USERNAME: emailOf(key), PASSWORD: password },
    }),
  );
  const token = auth.AuthenticationResult?.IdToken;
  if (!token) throw new Error(`could not sign in as ${key}`);
  return token;
}

type Json = Record<string, any>;

async function call(token: string, method: string, path: string, body?: unknown): Promise<Json> {
  const res = await fetch(API + path, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text.slice(0, 200)}`);
  return text ? (JSON.parse(text) as Json) : {};
}

const say = (token: string, convId: string, id: string, body: string) =>
  call(token, "POST", `/v1/conversations/${convId}/messages`, { clientMsgId: `test-accounts-${id}`, body });

const daysFromNow = (days: number, hour: number): string => {
  const at = new Date(Date.now() + days * 864e5);
  at.setUTCHours(hour, 0, 0, 0);
  return at.toISOString();
};

/** A little of everything, made through the API so it is exactly what the portal would make. */
async function seed(tokens: Record<string, string>, subs: Record<string, string>): Promise<NonNullable<State["seeded"]>> {
  const { admin, staff, athlete, guest } = tokens as Record<"admin" | "staff" | "athlete" | "guest", string>;

  const group = await call(admin, "POST", "/v1/groups", {
    title: "Test crew",
    about: "A sample group for trying the portal.",
    memberSubs: [subs["athlete"], subs["guest"]],
  });
  const groupId = group["id"] as string;
  await say(athlete, groupId, "g1", "Hey everyone, this is a test message.");
  await say(guest, groupId, "g2", "Got it. Testing from the guest account.");

  const desk = await call(athlete, "POST", "/v1/desks", { desk: "content" });
  const deskId = desk["id"] as string;
  await say(athlete, deskId, "d1", "Can someone check my last clip?");
  await say(staff, deskId, "d2", "Looks good. We will post it this week.");

  const poll = await call(staff, "POST", "/v1/events", {
    title: "Test stream night",
    kind: "stream",
    description: "A sample time poll. Pick the times that work.",
    audience: { type: "group", convId: groupId },
    options: [{ startsAt: daysFromNow(5, 23) }, { startsAt: daysFromNow(6, 23) }],
  });
  const set = await call(staff, "POST", "/v1/events", {
    title: "Test media day",
    kind: "shoot",
    description: "A sample event with a set time.",
    location: "Test studio",
    audience: { type: "group", convId: groupId },
    options: [{ startsAt: daysFromNow(9, 18) }],
  });

  const posting = await call(staff, "POST", "/v1/postings", {
    title: "Test posting: campus reporter",
    about: "A sample role athletes can raise a hand for.",
    details: "This posting is for testing. Nothing here is real.",
    requiresApproval: true,
    status: "open",
  });
  await call(athlete, "POST", `/v1/postings/${posting["id"]}/action`, { action: "interest", interested: true });
  await call(athlete, "PUT", "/v1/availability", { slots: ["thu-evening", "sat-afternoon"], timezone: "America/New_York" });

  return { convs: [groupId, deskId], events: [poll["id"], set["id"]], postings: [posting["id"]] };
}

async function purgePartition(pk: string): Promise<void> {
  const { getDocClient } = await import("../src/lib/db");
  let startKey: Record<string, unknown> | undefined;
  do {
    const page = await getDocClient().send(
      new QueryCommand({
        TableName: table,
        KeyConditionExpression: "PK = :pk",
        ExpressionAttributeValues: { ":pk": pk },
        ExclusiveStartKey: startKey,
      }),
    );
    for (const item of page.Items ?? []) {
      await getDocClient().send(new DeleteCommand({ TableName: table, Key: { PK: item["PK"], SK: item["SK"] } }));
    }
    startKey = page.LastEvaluatedKey;
  } while (startKey);
}

async function remove(state: State): Promise<void> {
  const { deletePending } = await import("../src/lib/portal/pending");
  for (const id of state.seeded?.convs ?? []) await purgePartition(`CONV#${id}`);
  for (const id of state.seeded?.events ?? []) await purgePartition(`PEVENT#${id}`);
  for (const id of state.seeded?.postings ?? []) await purgePartition(`POSTING#${id}`);
  await deletePending(PENDING_ID);
  await purgePartition(`USER#${WAITING_SUB}`);
  for (const account of ACCOUNTS) {
    const email = emailOf(account.key);
    const sub = await subOf(email);
    if (!sub) continue;
    await purgePartition(`USER#${sub}`);
    await cognito.send(new AdminDeleteUserCommand({ UserPoolId: USER_POOL_ID, Username: email }));
  }
  await ssm.send(new DeleteParameterCommand({ Name: STATE_PARAM })).catch(() => undefined);
  console.log("removed the test accounts and their sample content");
}

async function main(): Promise<void> {
  if (!API.includes("execute-api")) throw new Error("set PORTAL_API_URL to the dev PortalApiUrl output");
  const state = await readState();
  if (flag("remove")) return remove(state);

  const { putMember, getMember } = await import("../src/lib/portal/members");
  const { syncChannelMemberships } = await import("../src/lib/portal/conversations");
  const { savePending } = await import("../src/lib/portal/pending");

  const now = new Date().toISOString();
  const subs: Record<string, string> = {};
  const tokens: Record<string, string> = {};
  for (const account of ACCOUNTS) {
    const password = (!flag("rotate") && state.passwords[account.key]) || newPassword();
    state.passwords[account.key] = password;
    const sub = await ensureUser(account, password);
    subs[account.key] = sub;
    const existing = await getMember(sub);
    const member = PortalMember.parse({
      ...(existing ?? {}),
      sub,
      email: emailOf(account.key),
      name: account.name,
      role: account.role,
      status: "active",
      desks: account.desks ?? [],
      ...account.extra,
      edited: existing?.edited ?? [],
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
    await putMember(member);
    await syncChannelMemberships(member);
    tokens[account.key] = await tokenFor(account.key, password);
  }
  await saveState(state);

  const supportEmail = arg("support-email");
  if (supportEmail) {
    const settings = await call(tokens["admin"]!, "GET", "/v1/settings");
    await call(tokens["admin"]!, "PUT", "/v1/settings", { ...settings, supportEmail });
  }

  if (!state.seeded) {
    state.seeded = await seed(tokens, subs);
    await saveState(state);
    // Rows the admin account can act on: one to enable, one to invite or link.
    await putMember(
      PortalMember.parse({
        sub: WAITING_SUB,
        email: emailOf("waiting"),
        name: "Waiting Tester",
        role: "athlete",
        status: "ready",
        desks: [],
        sport: "Rowing",
        edited: [],
        createdAt: now,
      }),
    );
    await savePending({
      applicationId: PENDING_ID,
      email: emailOf("pending"),
      name: "Pending Tester",
      sport: "Football",
      firstSeenAt: now,
    });
  }

  console.log("\nSign in at https://portal-dev.niltv.com\n");
  for (const account of ACCOUNTS) {
    console.log(`${account.role.padEnd(8)} ${emailOf(account.key).padEnd(32)} ${state.passwords[account.key]}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
