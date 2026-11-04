/**
 * niltv.com account lookup. Portal access is granted to an existing site
 * account, found by email in the stage's Cognito pool. The account's `sub`
 * becomes the portal member key, the same id every API token carries.
 *
 * Only a confirmed account with a verified email counts. Anyone can type any
 * address into a new account, or change their account's email, so an unproven
 * address must never pick up someone else's portal access.
 */
import { CognitoIdentityProviderClient, ListUsersCommand } from "@aws-sdk/client-cognito-identity-provider";

let cognito: CognitoIdentityProviderClient | undefined;
const getCognito = (): CognitoIdentityProviderClient => (cognito ??= new CognitoIdentityProviderClient({}));

export interface SiteAccount {
  sub: string;
  email: string;
  name?: string;
}

export async function findAccountByEmail(email: string): Promise<SiteAccount | undefined> {
  const poolId = process.env.USER_POOL_ID;
  if (!poolId) throw new Error("USER_POOL_ID unset");
  const clean = email.trim().toLowerCase().replace(/["\\]/g, "");
  const out = await getCognito().send(
    new ListUsersCommand({ UserPoolId: poolId, Filter: `email = "${clean}"`, Limit: 5 }),
  );
  for (const user of out.Users ?? []) {
    if (user.Enabled === false || user.UserStatus !== "CONFIRMED") continue;
    const attrs = new Map((user.Attributes ?? []).map((a) => [a.Name ?? "", a.Value ?? ""]));
    const sub = attrs.get("sub");
    if (!sub || attrs.get("email_verified") !== "true") continue;
    const name = attrs.get("name");
    return { sub, email: attrs.get("email") ?? clean, ...(name ? { name } : {}) };
  }
  return undefined;
}

/** "jordan.miles@duke.edu" → "Jordan Miles" when no name is on file. */
export function nameFromEmail(email: string): string {
  const local = email.split("@")[0] ?? email;
  const words = local.split(/[._-]+/).filter(Boolean);
  return words.length > 0 ? words.map((w) => w[0]!.toUpperCase() + w.slice(1)).join(" ") : email;
}
