/**
 * The portal has no sign-up of its own. Portal and niltv.com share one
 * account, and athletes make it on niltv.com with the email on their
 * application; the portal only signs people in.
 */

export const CREATE_ACCOUNT_PATH = "/create-account";

/** niltv.com opens its sign-up box for this link, with the address filled in when given. */
export const siteSignupUrl = (email?: string): string =>
  `https://niltv.com/?account=create${email ? `&email=${encodeURIComponent(email)}` : ""}`;

/**
 * An old invite link (/create-account?email=...) still lands somewhere useful:
 * sign-in, with the address filled in and a pointer to niltv.com.
 */
export function inviteFromUrl(pathname: string, search: string): { create: boolean; email: string } {
  const create = pathname.replace(/\/+$/, "") === CREATE_ACCOUNT_PATH;
  const email = create ? (new URLSearchParams(search).get("email") ?? "").trim() : "";
  return { create, email };
}
