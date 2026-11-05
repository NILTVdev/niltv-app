/**
 * Availability heatmap cell shading: gold at an opacity that grows with the
 * share of responders free in that half hour (same ramp as the approved mockup),
 * with dark text once the cell is dark enough.
 */
import { DAY_TIMES, WEEKDAYS } from "@niltv/types";

export type Weekday = (typeof WEEKDAYS)[number];

export const slotKey = (day: Weekday, time: string): string => `${day}-${time}`;

/** Row label: the hour on the hour, nothing on the half hour. */
export function hourLabel(time: string): string {
  if (!time.endsWith("00")) return "";
  const hour = Number(time.slice(0, 2));
  return `${hour % 12 || 12} ${hour < 12 ? "AM" : "PM"}`;
}

/** Make other days match one day. */
export function copyDay(slots: ReadonlySet<string>, from: Weekday, to: readonly Weekday[]): Set<string> {
  const next = new Set([...slots].filter((s) => !to.some((d) => s.startsWith(`${d}-`))));
  for (const s of slots) {
    if (!s.startsWith(`${from}-`)) continue;
    const time = s.slice(from.length + 1);
    for (const d of to) next.add(slotKey(d, time));
  }
  return next;
}

export const WEEKDAY_LABELS: Record<Weekday, string> = {
  mon: "Mon",
  tue: "Tue",
  wed: "Wed",
  thu: "Thu",
  fri: "Fri",
  sat: "Sat",
  sun: "Sun",
};

const GOLD = "211,179,104"; // NIL TV Gold #D3B368

/** Share of `total` (0..1), safe for a zero total. */
export const heatRatio = (count: number, total: number): number =>
  total > 0 ? Math.min(1, Math.max(0, count / total)) : 0;

export function heatShade(count: number, total: number): { background: string; color: string } {
  const ratio = heatRatio(count, total);
  const alpha = (0.08 + 0.85 * ratio).toFixed(2);
  return {
    background: `rgba(${GOLD},${alpha})`,
    color: ratio > 0.6 ? "var(--on-gold)" : "var(--text)",
  };
}

/** The busiest cells, most people first, for "Best times". Ties keep week order. */
export function bestSlots<T extends { slot: string; count: number }>(cells: readonly T[], take = 3): T[] {
  const order = new Map<string, number>();
  let i = 0;
  for (const time of DAY_TIMES) for (const day of WEEKDAYS) order.set(slotKey(day, time), i++);
  return [...cells]
    .filter((c) => c.count > 0)
    .sort((a, b) => b.count - a.count || (order.get(a.slot) ?? 0) - (order.get(b.slot) ?? 0))
    .slice(0, take);
}
