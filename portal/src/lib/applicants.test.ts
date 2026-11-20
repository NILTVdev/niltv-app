import type { PortalApplicant } from "@niltv/types";
import { describe, expect, it } from "vitest";
import { applicantSteps, nextStep, standing } from "./applicants";

const a = (over: Partial<PortalApplicant> = {}): PortalApplicant => ({
  applicationId: 7,
  name: "Jordan Miles",
  email: "jordan.miles@example.edu",
  stage: "accepted",
  international: false,
  hasAccount: true,
  ...over,
});

const states = (x: PortalApplicant) => Object.fromEntries(applicantSteps(x).map((s) => [s.key, s.state]));

describe("applicantSteps", () => {
  it("marks every step done for an active member", () => {
    expect(states(a({ memberStatus: "active", memberSub: "u-1" }))).toEqual({
      account: "done",
      approved: "done",
      agreement: "done",
      stripe: "done",
      portal: "done",
    });
  });

  it("shows nothing done on a fresh application", () => {
    expect(states(a({ stage: "applied", hasAccount: false }))).toEqual({
      account: "todo",
      approved: "todo",
      agreement: "todo",
      stripe: "todo",
      portal: "todo",
    });
  });

  it("skips Stripe for international athletes", () => {
    expect(states(a({ stage: "signed", international: true })).stripe).toBe("skipped");
  });

  it("counts the agreement as signed from signed onward", () => {
    expect(states(a({ stage: "agreement_sent" })).agreement).toBe("todo");
    expect(states(a({ stage: "stripe_pending" })).agreement).toBe("done");
  });
});

describe("standing", () => {
  it("is ready only when accepted with a waiting member row", () => {
    expect(standing(a({ memberStatus: "ready", memberSub: "u-1" }))).toBe("ready");
  });
  it("waits on the sync when accepted with an account and no member yet", () => {
    expect(standing(a())).toBe("syncing");
  });
  it("needs an account when accepted with none", () => {
    expect(standing(a({ hasAccount: false }))).toBe("account");
  });
  it("is onboarding before accepted, whatever the account", () => {
    expect(standing(a({ stage: "signed", memberStatus: "ready" }))).toBe("onboarding");
  });
  it("follows the member status once in the portal", () => {
    expect(standing(a({ memberStatus: "active" }))).toBe("active");
    expect(standing(a({ memberStatus: "disabled" }))).toBe("disabled");
  });
});

describe("nextStep", () => {
  it("names what onboarding is waiting on", () => {
    expect(nextStep(a({ stage: "applied" }))).toMatch(/staff review/);
    expect(nextStep(a({ stage: "agreement_sent" }))).toMatch(/agreement/);
    expect(nextStep(a({ stage: "stripe_pending" }))).toMatch(/Stripe/);
    expect(nextStep(a({ stage: "signed", international: true }))).toMatch(/accept/);
  });
});
