/** Pure helpers for the create-account step. */

export const CREATE_ACCOUNT_PATH = "/create-account";

/** The portal roster is 18 and older. The shared pool's own gate is 13. */
export const MIN_AGE = 18;

/** The invite email links to /create-account?email=...: open that step with the address filled in. */
export function inviteFromUrl(pathname: string, search: string): { create: boolean; email: string } {
  const create = pathname.replace(/\/+$/, "") === CREATE_ACCOUNT_PATH;
  const email = create ? (new URLSearchParams(search).get("email") ?? "").trim() : "";
  return { create, email };
}

/** Whole years old on `today`, or null when the date cannot be used. Takes YYYY-MM-DD from a date input. */
export function ageOn(birthdate: string, today: Date): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(birthdate);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const born = new Date(Date.UTC(year, month - 1, day));
  if (born.getUTCMonth() !== month - 1 || born.getUTCDate() !== day || born.getTime() > today.getTime()) return null;
  const hadBirthday =
    today.getMonth() + 1 > month || (today.getMonth() + 1 === month && today.getDate() >= day);
  return today.getFullYear() - year - (hadBirthday ? 0 : 1);
}
