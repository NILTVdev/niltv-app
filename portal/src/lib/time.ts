/**
 * Times are stored in UTC; every screen shows them in the viewer's zone
 * (the account time zone, else the browser's), with the zone abbreviation.
 * The datetime-local inputs on the event form are read in that same zone.
 * Pure: Intl only, no DOM.
 */

export function browserZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** A zone the runtime accepts, else the fallback. */
export function validZone(tz: string | undefined, fallback = "UTC"): string {
  if (!tz) return fallback;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return fallback;
  }
}

/** Every IANA zone the browser knows, for the time zone select. */
export function listTimeZones(): string[] {
  try {
    return Intl.supportedValuesOf("timeZone");
  } catch {
    return ["UTC", "America/New_York", "America/Chicago", "America/Denver", "America/Phoenix", "America/Los_Angeles"];
  }
}

const toDate = (value: string | Date): Date => (value instanceof Date ? value : new Date(value));

interface WallParts {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
  s: number;
}

const partFormatters = new Map<string, Intl.DateTimeFormat>();

function wallParts(date: Date, tz: string): WallParts {
  let f = partFormatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    partFormatters.set(tz, f);
  }
  const p: Record<string, string> = {};
  for (const part of f.formatToParts(date)) p[part.type] = part.value;
  return {
    y: Number(p["year"]),
    mo: Number(p["month"]),
    d: Number(p["day"]),
    h: Number(p["hour"]) % 24,
    mi: Number(p["minute"]),
    s: Number(p["second"]),
  };
}

/** Offset of `tz` from UTC at that instant, in ms (New York in summer = -4h). */
export function tzOffsetMs(date: Date, tz: string): number {
  const p = wallParts(date, tz);
  const asUtc = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s);
  return asUtc - (date.getTime() - date.getUTCMilliseconds());
}

/** "2026-10-23T21:00" read as a wall time in `tz` → the UTC instant. */
export function wallTimeToUtc(local: string, tz: string): Date | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(local);
  if (!m) return undefined;
  const guess = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  if (Number.isNaN(guess)) return undefined;
  // Two passes settle the offset across a DST change.
  const first = guess - tzOffsetMs(new Date(guess), tz);
  const second = guess - tzOffsetMs(new Date(first), tz);
  return new Date(second);
}

const pad = (n: number): string => String(n).padStart(2, "0");

/** A UTC instant as the "YYYY-MM-DDTHH:mm" a datetime-local input shows in `tz`. */
export function utcToWallTime(value: string | Date, tz: string): string {
  const p = wallParts(toDate(value), tz);
  return `${p.y}-${pad(p.mo)}-${pad(p.d)}T${pad(p.h)}:${pad(p.mi)}`;
}

/** "EDT", "CST", or "GMT+2" where the locale has no short name. */
export function zoneAbbr(value: string | Date, tz: string): string {
  try {
    const part = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "short" })
      .formatToParts(toDate(value))
      .find((p) => p.type === "timeZoneName");
    return part?.value ?? tz;
  } catch {
    return tz;
  }
}

const fmt = (tz: string, options: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat("en-US", { timeZone: tz, ...options });

/** Days from `a` to `b` by calendar date in `tz` (b tomorrow = 1). */
export function dayDiff(a: Date, b: Date, tz: string): number {
  const pa = wallParts(a, tz);
  const pb = wallParts(b, tz);
  return Math.round((Date.UTC(pb.y, pb.mo - 1, pb.d) - Date.UTC(pa.y, pa.mo - 1, pa.d)) / 86_400_000);
}

const sameYear = (a: Date, b: Date, tz: string): boolean => wallParts(a, tz).y === wallParts(b, tz).y;

/** "9:00 PM" */
export const formatClock = (value: string | Date, tz: string): string =>
  fmt(tz, { hour: "numeric", minute: "2-digit" }).format(toDate(value));

/** "Thu, Oct 23" (+ year when not this year) */
export function formatDay(value: string | Date, tz: string, now: Date = new Date()): string {
  const d = toDate(value);
  return fmt(tz, {
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(sameYear(d, now, tz) ? {} : { year: "numeric" }),
  }).format(d);
}

/** "Oct 23" (+ year when not this year) */
export function formatShortDate(value: string | Date, tz: string, now: Date = new Date()): string {
  const d = toDate(value);
  return fmt(tz, { month: "short", day: "numeric", ...(sameYear(d, now, tz) ? {} : { year: "numeric" }) }).format(d);
}

/** "Thu, Oct 23, 9:00 PM EDT" */
export function formatDateTime(value: string | Date, tz: string, now: Date = new Date()): string {
  const d = toDate(value);
  return `${formatDay(d, tz, now)}, ${formatClock(d, tz)} ${zoneAbbr(d, tz)}`;
}

/** "Thu, Oct 23, 9:00 PM to 11:00 PM EDT", or across days "… to Fri, Oct 24, 1:00 AM EDT". */
export function formatRange(start: string | Date, end: string | Date | undefined, tz: string, now: Date = new Date()): string {
  const s = toDate(start);
  if (!end) return formatDateTime(s, tz, now);
  const e = toDate(end);
  if (dayDiff(s, e, tz) === 0) return `${formatDay(s, tz, now)}, ${formatClock(s, tz)} to ${formatClock(e, tz)} ${zoneAbbr(e, tz)}`;
  return `${formatDay(s, tz, now)}, ${formatClock(s, tz)} to ${formatDay(e, tz, now)}, ${formatClock(e, tz)} ${zoneAbbr(e, tz)}`;
}

/** Message stamps: "9:05 AM" today, "Yesterday 9:05 AM", "Mon 9:05 AM" this week, else "Oct 1". */
export function formatMessageTime(value: string | Date, tz: string, now: Date = new Date()): string {
  const d = toDate(value);
  const diff = dayDiff(d, now, tz);
  if (diff <= 0) return formatClock(d, tz);
  if (diff === 1) return `Yesterday ${formatClock(d, tz)}`;
  if (diff < 7) return `${fmt(tz, { weekday: "short" }).format(d)} ${formatClock(d, tz)}`;
  return formatShortDate(d, tz, now);
}

/** "Today", "Yesterday", "Oct 13", or "Never". */
export function formatSeen(value: string | undefined, tz: string, now: Date = new Date()): string {
  if (!value) return "Never";
  const d = toDate(value);
  const diff = dayDiff(d, now, tz);
  if (diff <= 0) return "Today";
  if (diff === 1) return "Yesterday";
  return formatShortDate(d, tz, now);
}
