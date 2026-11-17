/** Options for the type-or-scroll box, and the lists most screens pass it. */
import { PORTAL_SPORTS } from "@niltv/types";
import { CAMPUS_OPTIONS } from "./format";

export interface ComboOption {
  value: string;
  label: string;
}

/** Names that start with what was typed come first, then names that contain it. */
export function matchOptions(options: readonly ComboOption[], query: string): ComboOption[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...options];
  const starts = options.filter((o) => o.label.toLowerCase().startsWith(q));
  const contains = options.filter((o) => !o.label.toLowerCase().startsWith(q) && o.label.toLowerCase().includes(q));
  return [...starts, ...contains];
}

export const CAMPUS_COMBO: ComboOption[] = CAMPUS_OPTIONS.map((c) => ({ value: c.slug, label: c.name }));
export const SPORT_COMBO: ComboOption[] = PORTAL_SPORTS.map((s) => ({ value: s, label: s }));
