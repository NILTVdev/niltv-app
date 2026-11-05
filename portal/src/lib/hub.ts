/** Content Hub rules shared by the screens and the menu badge. */
import type { Ask, ClaimStatus } from "@niltv/types";
import type { Tone } from "./format";

export const CLAIM: Record<ClaimStatus, { label: string; tone: Tone }> = {
  requested: { label: "Needs approval", tone: "neutral" },
  claimed: { label: "Claimed", tone: "warn" },
  submitted: { label: "In review", tone: "info" },
  changes: { label: "Needs changes", tone: "bad" },
  delivered: { label: "Delivered", tone: "ok" },
  declined: { label: "Not approved", tone: "bad" },
};

/** Athletes: work sent back to them. Staff: requests and content waiting on a decision. */
export function hubCount(asks: readonly Ask[], staff: boolean): number {
  if (!staff) return asks.filter((a) => a.myClaim?.status === "changes").length;
  return asks.flatMap((a) => a.claims ?? []).filter((c) => c.status === "requested" || c.status === "submitted").length;
}

/** The three athlete tabs. A declined claim stays under My claims so the answer is visible. */
export function splitAsks(asks: readonly Ask[]): { open: Ask[]; mine: Ask[]; done: Ask[] } {
  return {
    open: asks.filter((a) => !a.myClaim),
    mine: asks.filter((a) => a.myClaim && a.myClaim.status !== "delivered"),
    done: asks.filter((a) => a.myClaim?.status === "delivered"),
  };
}

export const formatBytes = (bytes: number): string => {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
};
