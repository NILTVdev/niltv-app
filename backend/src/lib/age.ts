/**
 * Age math shared by the Cognito triggers (design §6.2, §10). Cognito stores
 * the standard `birthdate` attribute as "YYYY-MM-DD"; all math is UTC and
 * month/day aware — a birthday counts from the day itself, not the year delta.
 */

const BIRTHDATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export interface BirthdateParts {
  year: number;
  month: number; // 1–12
  day: number; // 1–31
}

/** Strict "YYYY-MM-DD" parse; null for malformed or impossible calendar dates. */
export function parseBirthdate(birthdate: string): BirthdateParts | null {
  const match = BIRTHDATE_RE.exec(birthdate);
  if (!match) return null;
  const [, yearStr, monthStr, dayStr] = match;
  if (!yearStr || !monthStr || !dayStr) return null;
  const year = Number(yearStr);
  const month = Number(monthStr);
  const day = Number(dayStr);
  // Round-trip through Date to reject impossible dates (2013-02-30, month 13, …).
  const roundTrip = new Date(Date.UTC(year, month - 1, day));
  if (
    roundTrip.getUTCFullYear() !== year ||
    roundTrip.getUTCMonth() !== month - 1 ||
    roundTrip.getUTCDate() !== day
  ) {
    return null;
  }
  return { year, month, day };
}

/**
 * Completed years of age at `now` (UTC), or null when the birthdate is
 * malformed. Feb-29 birthdays tick over on Mar 1 in non-leap years.
 */
export function computeAge(birthdate: string, now: Date = new Date()): number | null {
  const parts = parseBirthdate(birthdate);
  if (!parts) return null;
  let age = now.getUTCFullYear() - parts.year;
  const monthNow = now.getUTCMonth() + 1;
  const dayNow = now.getUTCDate();
  if (monthNow < parts.month || (monthNow === parts.month && dayNow < parts.day)) {
    age -= 1;
  }
  return age;
}

/** Convenience for the 18+ vote gate (design §6.3): false when unknown/malformed. */
export function is18Plus(birthdate: string, now: Date = new Date()): boolean {
  const age = computeAge(birthdate, now);
  return age !== null && age >= 18;
}
