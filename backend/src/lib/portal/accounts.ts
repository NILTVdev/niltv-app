/**
 * niltv.com account lookup. Portal access is granted to an existing site
 * account, found by email in the stage's Cognito pool. The account's `sub`
 * becomes the portal member key, the same id every API token carries.
 */
import { CognitoIdentityProviderClient, ListUsersCommand } from "@aws-sdk/client-cognito-identity-provider";

let cognito: CognitoIdentityProviderClient | undefined;
const getCognito = (): CognitoIdentityProviderClient => (cognito ??= new CognitoIdentityProviderClient({}));

export interface SiteAccount {
  sub: string;
  email: string;
  name?: string;
  emailVerified: boolean;
}

export async function findAccountByEmail(email: string): Promise<SiteAccount | undefined> {
  const poolId = process.env.USER_POOL_ID;
  if (!poolId) throw new Error("USER_POOL_ID unset");
  const clean = email.trim().toLowerCase().replace(/["\\]/g, "");
  const out = await getCognito().send(
    new ListUsersCommand({ UserPoolId: poolId, Filter: `email = "${clean}"`, Limit: 5 }),
  );
  const accounts: SiteAccount[] = [];
  for (const user of out.Users ?? []) {
    if (user.Enabled === false) continue;
    const attrs = new Map((user.Attributes ?? []).map((a) => [a.Name ?? "", a.Value ?? ""]));
    const sub = attrs.get("sub");
    if (!sub) continue;
    const name = attrs.get("name");
    accounts.push({
      sub,
      email: attrs.get("email") ?? clean,
      ...(name ? { name } : {}),
      emailVerified: attrs.get("email_verified") === "true",
    });
  }
  // Prefer a verified account if the email somehow maps to more than one.
  return accounts.find((a) => a.emailVerified) ?? accounts[0];
}

/** "jordan.miles@duke.edu" → "Jordan Miles" when no name is on file. */
export function nameFromEmail(email: string): string {
  const local = email.split("@")[0] ?? email;
  const words = local.split(/[._-]+/).filter(Boolean);
  return words.length > 0 ? words.map((w) => w[0]!.toUpperCase() + w.slice(1)).join(" ") : email;
}
