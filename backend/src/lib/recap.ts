/**
 * Leaderboard snapshot (design §6.5): computed once by the →ended transition
 * and frozen onto the event item — the recap never recomputes. Pure so the
 * ranking rule is unit-testable.
 */
import type { EventRecap } from "@niltv/types";
import type { Item } from "./shape";

const votesOf = (entry: Item): number => (typeof entry["votes"] === "number" ? entry["votes"] : 0);

/**
 * Rank entries by votes descending (ties broken by entry id ascending, so the
 * snapshot is deterministic under any input order). Undefined when the event
 * has no entries — an entry-less event simply carries no recap.
 */
export function computeRecap(eventRow: Item, entries: Item[]): EventRecap | undefined {
  if (entries.length === 0) return undefined;

  const ranked = [...entries].sort((a, b) => {
    const diff = votesOf(b) - votesOf(a);
    return diff !== 0 ? diff : String(a["id"]).localeCompare(String(b["id"]));
  });

  const startsAt = Date.parse(String(eventRow["startsAt"]));
  const endsAt = Date.parse(String(eventRow["endsAt"]));
  const daysLive =
    Number.isNaN(startsAt) || Number.isNaN(endsAt)
      ? 0
      : Math.max(1, Math.ceil((endsAt - startsAt) / 86_400_000));

  return {
    championEntryId: String(ranked[0]?.["id"]),
    leaderboard: ranked.map((entry, index) => ({
      entryId: String(entry["id"]),
      rank: index + 1,
      votes: votesOf(entry),
    })),
    totals: {
      votes: ranked.reduce((sum, entry) => sum + votesOf(entry), 0),
      entries: ranked.length,
      daysLive,
    },
  };
}
