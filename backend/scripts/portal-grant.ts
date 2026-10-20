/**
 * Give an existing niltv.com account portal access, or change its role.
 * The way in for the first admin; after that admins use Team & access.
 *
 *   npx tsx scripts/portal-grant.ts --stage dev --email someone@niltv.com --role admin [--desks content,support,payments] [--name "Name"]
 *   npx tsx scripts/portal-grant.ts --stage dev --email someone@niltv.com --disable
 *
 * Prod needs --confirm-prod. Idempotent: re-running updates the same row.
 */
import { CognitoIdentityProviderClient, ListUserPoolsCommand } from "@aws-sdk/client-cognito-identity-provider";
import { Desk, PortalMember, PortalRole, isStaffRole } from "@niltv/types";

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const flag = (name: string): boolean => process.argv.includes(`--${name}`);

async function poolIdFor(stage: string): Promise<string> {
  const cognito = new CognitoIdentityProviderClient({ region: "us-east-1" });
  let token: string | undefined;
  do {
    const out = await cognito.send(new ListUserPoolsCommand({ MaxResults: 60, NextToken: token }));
    const hit = (out.UserPools ?? []).find((p) => p.Name === `niltv-${stage}`);
    if (hit?.Id) return hit.Id;
    token = out.NextToken;
  } while (token);
  throw new Error(`no user pool named niltv-${stage}`);
}

async function main(): Promise<void> {
  const stage = arg("stage") ?? "dev";
  if (stage === "prod" && !flag("confirm-prod")) throw new Error("refusing prod without --confirm-prod");
  const email = arg("email");
  if (!email) throw new Error("--email is required");

  process.env.TABLE_NAME = `niltv-${stage}`;
  process.env.USER_POOL_ID = await poolIdFor(stage);
  // Imported after the env is set: the libs read it per call, but keep the order obvious.
  const { findAccountByEmail, nameFromEmail } = await import("../src/lib/portal/accounts");
  const { getMember, putMember } = await import("../src/lib/portal/members");
  const { leaveAllGroups, syncChannelMemberships } = await import("../src/lib/portal/conversations");

  const account = await findAccountByEmail(email);
  if (!account) throw new Error(`no niltv-${stage} account uses ${email}; sign up on the site first`);
  const existing = await getMember(account.sub);
  const now = new Date().toISOString();

  if (flag("disable")) {
    if (!existing) throw new Error("no portal row to disable");
    const next = { ...existing, status: "disabled" as const, updatedAt: now };
    await putMember(next);
    await syncChannelMemberships(next);
    await leaveAllGroups(next.sub);
    console.log(`disabled ${existing.name} (${existing.role})`);
    return;
  }

  const role = PortalRole.parse(arg("role") ?? existing?.role ?? "athlete");
  const desks = (arg("desks") ?? "")
    .split(",")
    .map((d) => d.trim())
    .filter(Boolean)
    .map((d) => Desk.parse(d));
  const member = PortalMember.parse({
    ...(existing ?? {}),
    sub: account.sub,
    email: account.email,
    name: arg("name") ?? existing?.name ?? account.name ?? nameFromEmail(account.email),
    role,
    status: "active",
    desks: isStaffRole(role) ? (desks.length > 0 ? desks : (existing?.desks ?? [])) : [],
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  });
  await putMember(member);
  const channels = await syncChannelMemberships(member);
  console.log(`${existing ? "updated" : "granted"} ${member.name} <${member.email}> as ${member.role}`, {
    desks: member.desks,
    joined: channels.joined,
    left: channels.left,
  });
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
