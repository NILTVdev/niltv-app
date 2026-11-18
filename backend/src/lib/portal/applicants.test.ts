import { NotifyPrefs, type PortalMember } from "@niltv/types";
import { describe, expect, it } from "vitest";
import { type DashboardApplication, buildApplicants } from "./applicants";

const app = (over: Partial<DashboardApplication> = {}): DashboardApplication => ({
  id: 7,
  email: "Jordan.Miles@example.edu",
  first_name: "Jordan",
  last_name: "Miles",
  university: "Example State",
  sport: "Football",
  campus_channel: null,
  international: false,
  status: "accepted",
  created_at: "2026-09-20T14:05:00",
  ...over,
});

const member = (over: Partial<PortalMember> = {}): PortalMember => ({
  sub: "u-1",
  email: "jordan.miles@example.edu",
  name: "Jordan Miles",
  role: "athlete",
  status: "ready",
  desks: [],
  edited: [],
  notify: NotifyPrefs.parse({}),
  createdAt: "2026-10-01T00:00:00.000Z",
  applicationId: 7,
  ...over,
});

describe("buildApplicants", () => {
  it("maps the dashboard status to a stage and reads naive timestamps as UTC", () => {
    const [row] = buildApplicants([app({ status: "applicant" })], new Set(), []);
    expect(row).toMatchObject({
      applicationId: 7,
      name: "Jordan Miles",
      email: "jordan.miles@example.edu",
      stage: "applied",
      hasAccount: false,
      appliedAt: "2026-09-20T14:05:00.000Z",
    });
    expect(row?.memberSub).toBeUndefined();
  });

  it("drops declined and unknown statuses", () => {
    expect(buildApplicants([app({ status: "declined" }), app({ id: 8, status: "mystery" })], new Set(), [])).toEqual([]);
  });

  it("counts a verified account on the application email", () => {
    const [row] = buildApplicants([app()], new Set(["jordan.miles@example.edu"]), []);
    expect(row?.hasAccount).toBe(true);
  });

  it("finds the member by application id even on another email", () => {
    const [row] = buildApplicants([app()], new Set(), [member({ email: "other@example.com" })]);
    expect(row).toMatchObject({ hasAccount: true, memberSub: "u-1", memberStatus: "ready" });
  });

  it("never matches by email a member already tied to another application", () => {
    const [row] = buildApplicants([app()], new Set(), [member({ applicationId: 99 })]);
    expect(row).toMatchObject({ hasAccount: false });
    expect(row?.memberSub).toBeUndefined();
  });

  it("does not offer approval for a staff member who also applied", () => {
    const [row] = buildApplicants([app()], new Set(), [member({ role: "staff" })]);
    expect(row?.hasAccount).toBe(true);
    expect(row?.memberStatus).toBeUndefined();
  });

  it("keeps the international flag and skips a bad date", () => {
    const [row] = buildApplicants([app({ international: true, created_at: "not a date" })], new Set(), []);
    expect(row?.international).toBe(true);
    expect(row?.appliedAt).toBeUndefined();
  });
});
