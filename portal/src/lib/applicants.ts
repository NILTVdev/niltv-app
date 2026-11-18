/** Pure helpers for the applicant list on Athletes: the steps, where each applicant stands, and the filters. */
import type { ApplicantStage, PortalApplicant } from "@niltv/types";

const ORDER: ApplicantStage[] = ["applied", "approved", "agreement_sent", "signed", "stripe_pending", "accepted"];
const atLeast = (stage: ApplicantStage, min: ApplicantStage): boolean => ORDER.indexOf(stage) >= ORDER.indexOf(min);

export type StepState = "done" | "todo" | "skipped";

export interface Step {
  key: "account" | "approved" | "agreement" | "stripe" | "portal";
  label: string;
  state: StepState;
}

/** The five things an athlete needs before portal access, in order. */
export function applicantSteps(a: PortalApplicant): Step[] {
  const stripe: StepState = a.stage === "accepted" ? "done" : a.international ? "skipped" : "todo";
  return [
    { key: "account", label: "niltv.com account", state: a.hasAccount ? "done" : "todo" },
    { key: "approved", label: "Application approved", state: atLeast(a.stage, "approved") ? "done" : "todo" },
    { key: "agreement", label: "Agreement signed", state: atLeast(a.stage, "signed") ? "done" : "todo" },
    { key: "stripe", label: a.international ? "Stripe (not needed)" : "Stripe set up", state: stripe },
    { key: "portal", label: "Portal access", state: a.memberStatus === "active" ? "done" : "todo" },
  ];
}

/**
 * Where the applicant stands, as one filterable state.
 * - ready: every step done, waiting for an admin to approve
 * - syncing: accepted with an account; the roster sync adds them within 30 minutes
 * - account: accepted, but no niltv.com account on the application email
 * - onboarding: still in staff review, the agreement or Stripe (the dashboard's steps)
 * - active / disabled: already a portal member
 */
export type Standing = "ready" | "syncing" | "account" | "onboarding" | "active" | "disabled";

export function standing(a: PortalApplicant): Standing {
  if (a.memberStatus === "active") return "active";
  if (a.memberStatus === "disabled") return "disabled";
  if (a.stage !== "accepted") return "onboarding";
  if (a.memberStatus === "ready") return "ready";
  return a.hasAccount ? "syncing" : "account";
}

/** What the onboarding athlete is waiting on, in the team's words. */
export function nextStep(a: PortalApplicant): string {
  switch (a.stage) {
    case "applied":
      return "Waiting for staff review in the dashboard";
    case "approved":
    case "agreement_sent":
      return "Waiting on the signed agreement";
    case "signed":
    case "stripe_pending":
      return a.international ? "Waiting on the dashboard to accept" : "Waiting on Stripe setup";
    case "accepted":
      return "";
  }
}

export const STANDING_LABEL: Record<Standing, string> = {
  ready: "Ready to approve",
  syncing: "Joining the list",
  account: "Needs a niltv.com account",
  onboarding: "In onboarding",
  active: "In the portal",
  disabled: "Access off",
};
