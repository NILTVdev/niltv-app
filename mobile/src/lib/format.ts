/** 987 → "987" · 12_400 → "12.4K" · 2_300_000 → "2.3M" (demo's stat formatting). */
/**
 * Card attribution line. Channel clips credit the channel's own pseudo-profile,
 * which made "NIL TV · NIL TV" — identical names collapse to one.
 */
export function attribution(channelName: string, creatorName: string): string {
  return channelName === creatorName ? channelName : `${channelName} · ${creatorName}`;
}

export function formatCount(n: number): string {
  if (n >= 1_000_000) return `${trimZero(n / 1_000_000)}M`;
  if (n >= 1_000) return `${trimZero(n / 1_000)}K`;
  return String(n);
}

function trimZero(value: number): string {
  const fixed = value.toFixed(1);
  return fixed.endsWith(".0") ? fixed.slice(0, -2) : fixed;
}

/** Seconds → "m:ss" for clip durations. */
export function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/**
 * School naming rule: a school name must never render alone — always
 * "School NIL Student Athletes". Data stays bare; the suffix is applied at
 * render time, everywhere a school is shown.
 */
export function nilSchool(school: string): string {
  const s = school.trim();
  if (!s) return "";
  return /nil student athletes$/i.test(s) ? s : `${s} NIL Student Athletes`;
}

/** The standard "School NIL Student Athletes · Sport" meta line; skips empty parts. */
export function schoolMeta(school: string, sport?: string): string {
  return [nilSchool(school), sport?.trim()].filter(Boolean).join(" · ");
}
