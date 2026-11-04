/**
 * niltv.com account lookup. Portal access is granted to an existing site
 * account, found by email in the stage's Cognito pool. The account's `sub`
 * becomes the portal member key, the same id every API token carries.
 *
 * Only a confirmed account with a verified email counts. Anyone can type any
 * address into a new account, or change their account's email, so an unproven
 * address must never pick up someone else's portal access.
 */
import {
  AdminDeleteUserCommand,
  CognitoIdentityProviderClient,
  ListUsersCommand,
} from "@aws-sdk/client-cognito-identity-provider";

let cognito: CognitoIdentityProviderClient | undefined;
const getCognito = (): CognitoIdentityProviderClient => (cognito ??= new CognitoIdentityProviderClient({}));

export interface SiteAccount {
  sub: string;
  email: string;
  name?: string;
}

/**
 * A sign-up nobody finished. It proves nothing and holds nothing, but it still
 * blocks the address: anyone who types an address can leave one behind, and the
 * real owner then cannot sign up, sign in or reset. Confirming it would be
 * worse, because whoever made it holds the password, so these get deleted.
 */
export interface UnfinishedSignup {
  username: string;
  createdAt: Date;
}

export interface EmailLookup {
  account?: SiteAccount;
  unfinished: UnfinishedSignup[];
}

export async function lookupEmail(email: string): Promise<EmailLookup> {
  const poolId = process.env.USER_POOL_ID;
  if (!poolId) throw new Error("USER_POOL_ID unset");
  const clean = email.trim().toLowerCase().replace(/["\\]/g, "");
  const out = await getCognito().send(
    new ListUsersCommand({ UserPoolId: poolId, Filter: `email = "${clean}"`, Limit: 5 }),
  );
  const found: EmailLookup = { unfinished: [] };
  for (const user of out.Users ?? []) {
    if (user.UserStatus === "UNCONFIRMED" && user.Username) {
      found.unfinished.push({ username: user.Username, createdAt: user.UserCreateDate ?? new Date(0) });
      continue;
    }
    if (found.account || user.Enabled === false || user.UserStatus !== "CONFIRMED") continue;
    const attrs = new Map((user.Attributes ?? []).map((a) => [a.Name ?? "", a.Value ?? ""]));
    const sub = attrs.get("sub");
    if (!sub || attrs.get("email_verified") !== "true") continue;
    const name = attrs.get("name");
    found.account = { sub, email: attrs.get("email") ?? clean, ...(name ? { name } : {}) };
  }
  return found;
}

export const findAccountByEmail = async (email: string): Promise<SiteAccount | undefined> =>
  (await lookupEmail(email)).account;

/** Free the address so its real owner can start over. */
export async function deleteUnfinished(signups: readonly UnfinishedSignup[]): Promise<void> {
  const poolId = process.env.USER_POOL_ID;
  if (!poolId) throw new Error("USER_POOL_ID unset");
  for (const { username } of signups) {
    await getCognito().send(new AdminDeleteUserCommand({ UserPoolId: poolId, Username: username }));
  }
}

/** "jordan.miles@duke.edu" → "Jordan Miles" when no name is on file. */
export function nameFromEmail(email: string): string {
  const local = email.split("@")[0] ?? email;
  const words = local.split(/[._-]+/).filter(Boolean);
  return words.length > 0 ? words.map((w) => w[0]!.toUpperCase() + w.slice(1)).join(" ") : email;
}
