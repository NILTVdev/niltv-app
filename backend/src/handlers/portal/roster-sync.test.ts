import { NotifyPrefs, type PendingAthlete, type PortalMember, PortalSettings } from "@niltv/types";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  getSettings: vi.fn(),
  listMembers: vi.fn(),
  getMember: vi.fn(),
  putMember: vi.fn(),
  createMember: vi.fn(),
  findAccountByEmail: vi.fn(),
  syncChannelMemberships: vi.fn(),
  enqueue: vi.fn(),
  listPending: vi.fn(),
  savePending: vi.fn(),
  deletePending: vi.fn(),
  claimInvite: vi.fn(),
  findProfileIdByHandle: vi.fn(),
}));

vi.mock("../../lib/roster", () => ({ dashboardApiKey: vi.fn() }));
vi.mock("../../lib/portal/members", () => ({
  getSettings: m.getSettings,
  listMembers: m.listMembers,
  getMember: m.getMember,
  putMember: m.putMember,
  createMember: m.createMember,
}));
vi.mock("../../lib/portal/accounts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/portal/accounts")>()),
  findAccountByEmail: m.findAccountByEmail,
}));
vi.mock("../../lib/portal/conversations", () => ({ syncChannelMemberships: m.syncChannelMemberships }));
vi.mock("../../lib/portal/notify", () => ({ enqueue: m.enqueue }));
vi.mock("../../lib/portal/pending", () => ({
  listPending: m.listPending,
  savePending: m.savePending,
  deletePending: m.deletePending,
  claimInvite: m.claimInvite,
}));
vi.mock("../../lib/portal/profiles", () => ({ findProfileIdByHandle: m.findProfileIdByHandle }));

import { type AcceptedApplication, syncRoster } from "./roster-sync";

const NOW = "2026-11-04T18:00:00.000Z";

const app = (over: Partial<AcceptedApplication> = {}): AcceptedApplication => ({
  id: 7,
  email: "Jordan.Miles@Example.edu",
  first_name: "Jordan",
  last_name: "Miles",
  university: "Example State",
  sport: "Football",
  year: "Senior",
  campus_channel: null,
  instagram: null,
  international: false,
  status: "accepted",
  ...over,
});

const athlete = (over: Partial<PortalMember> = {}): PortalMember => ({
  sub: "u-1",
  email: "jordan.miles@example.edu",
  name: "Jordan Miles",
  role: "athlete",
  status: "active",
  desks: [],
  edited: [],
  notify: NotifyPrefs.parse({}),
  createdAt: "2026-10-01T00:00:00.000Z",
  applicationId: 7,
  school: "Example State",
  sport: "Football",
  year: "Senior",
  stripe: "complete",
  ...over,
});

const pendingRow = (over: Partial<PendingAthlete> = {}): PendingAthlete => ({
  applicationId: 7,
  email: "jordan.miles@example.edu",
  name: "Jordan Miles",
  school: "Example State",
  sport: "Football",
  firstSeenAt: "2026-11-01T00:00:00.000Z",
  ...over,
});

const settings = (over: Partial<PortalSettings> = {}): PortalSettings => PortalSettings.parse({ ...over });

beforeEach(() => {
  vi.clearAllMocks();
  m.getSettings.mockResolvedValue(settings());
  m.listMembers.mockResolvedValue([]);
  m.getMember.mockResolvedValue(undefined);
  m.createMember.mockResolvedValue(true);
  m.findAccountByEmail.mockResolvedValue(undefined);
  m.listPending.mockResolvedValue([]);
  m.claimInvite.mockResolvedValue(pendingRow({ invitedAt: NOW }));
  m.findProfileIdByHandle.mockResolvedValue(undefined);
});

describe("an accepted athlete with no account", () => {
  it("goes on the pending list and sends nothing while the emails are off", async () => {
    const result = await syncRoster([app()], { now: NOW });
    expect(result).toMatchObject({ noAccount: 1, invited: 0, created: 0 });
    expect(m.savePending).toHaveBeenCalledWith(
      expect.objectContaining({ applicationId: 7, email: "jordan.miles@example.edu", name: "Jordan Miles", firstSeenAt: NOW }),
    );
    expect(m.claimInvite).not.toHaveBeenCalled();
    expect(m.enqueue).not.toHaveBeenCalled();
  });

  it("gets one invite once the emails are on", async () => {
    m.getSettings.mockResolvedValue(settings({ welcomeEmail: true }));
    const result = await syncRoster([app()], { now: NOW });
    expect(result.invited).toBe(1);
    expect(m.enqueue).toHaveBeenCalledWith({ type: "invite", applicationId: 7 });
  });

  it("is not invited twice", async () => {
    m.getSettings.mockResolvedValue(settings({ welcomeEmail: true }));
    m.listPending.mockResolvedValue([pendingRow({ invitedAt: "2026-11-02T00:00:00.000Z" })]);
    const result = await syncRoster([app()], { now: NOW });
    expect(result.invited).toBe(0);
    expect(m.claimInvite).not.toHaveBeenCalled();
    expect(m.enqueue).not.toHaveBeenCalled();
  });

  it("sends nothing when an admin claimed the invite first", async () => {
    m.getSettings.mockResolvedValue(settings({ welcomeEmail: true }));
    m.claimInvite.mockResolvedValue(undefined);
    const result = await syncRoster([app()], { now: NOW });
    expect(result.invited).toBe(0);
    expect(m.enqueue).not.toHaveBeenCalled();
  });

  it("does not rewrite a row that has not changed", async () => {
    m.listPending.mockResolvedValue([pendingRow()]);
    await syncRoster([app()], { now: NOW });
    expect(m.savePending).not.toHaveBeenCalled();
  });

  it("refreshes a row when the application changes", async () => {
    m.listPending.mockResolvedValue([pendingRow({ sport: "Rowing" })]);
    await syncRoster([app()], { now: NOW });
    expect(m.savePending).toHaveBeenCalledTimes(1);
  });
});

describe("matching an account", () => {
  it("tries the college email when the main email has no account", async () => {
    m.findAccountByEmail.mockImplementation(async (email: string) =>
      email === "jmiles@school.edu" ? { sub: "u-9", email } : undefined,
    );
    const result = await syncRoster([app({ college_email: "jmiles@school.edu" })], { now: NOW });
    expect(result).toMatchObject({ created: 1, noAccount: 0 });
    expect(m.createMember).toHaveBeenCalledWith(expect.objectContaining({ sub: "u-9", role: "athlete" }));
  });

  it("finds an existing member through the college email without calling Cognito", async () => {
    m.listMembers.mockResolvedValue([athlete({ email: "jmiles@school.edu", applicationId: undefined })]);
    await syncRoster([app({ college_email: "JMiles@school.edu" })], { now: NOW });
    expect(m.findAccountByEmail).not.toHaveBeenCalled();
    expect(m.savePending).not.toHaveBeenCalled();
  });

  it("creates the member and clears the pending row in the same run", async () => {
    m.findAccountByEmail.mockResolvedValue({ sub: "u-1", email: "jordan.miles@example.edu" });
    m.listPending.mockResolvedValue([pendingRow({ invitedAt: "2026-11-02T00:00:00.000Z" })]);
    const result = await syncRoster([app()], { now: NOW });
    expect(result).toMatchObject({ created: 1, noAccount: 0 });
    expect(m.deletePending).toHaveBeenCalledWith(7);
  });

  it("lands new athletes as ready while auto-enable is off", async () => {
    m.findAccountByEmail.mockResolvedValue({ sub: "u-1", email: "jordan.miles@example.edu" });
    await syncRoster([app()], { now: NOW });
    expect(m.createMember).toHaveBeenCalledWith(expect.objectContaining({ status: "ready" }));
    expect(m.syncChannelMemberships).not.toHaveBeenCalled();
    expect(m.enqueue).not.toHaveBeenCalled();
  });

  it("lands new athletes active, with channels and a welcome, when both switches are on", async () => {
    m.getSettings.mockResolvedValue(settings({ autoEnableAthletes: true, welcomeEmail: true }));
    m.findAccountByEmail.mockResolvedValue({ sub: "u-1", email: "jordan.miles@example.edu" });
    await syncRoster([app()], { now: NOW });
    expect(m.createMember).toHaveBeenCalledWith(expect.objectContaining({ status: "active" }));
    expect(m.syncChannelMemberships).toHaveBeenCalledTimes(1);
    expect(m.enqueue).toHaveBeenCalledWith({ type: "welcome", sub: "u-1" });
  });

  it("keeps staff who applied as staff and only records the link", async () => {
    m.listMembers.mockResolvedValue([athlete({ role: "staff", applicationId: undefined })]);
    await syncRoster([app()], { now: NOW });
    expect(m.putMember).toHaveBeenCalledWith(expect.objectContaining({ role: "staff", applicationId: 7 }));
    expect(m.syncChannelMemberships).not.toHaveBeenCalled();
  });
});

describe("auto-enable", () => {
  it("releases athletes already waiting", async () => {
    m.getSettings.mockResolvedValue(settings({ autoEnableAthletes: true, welcomeEmail: true }));
    m.listMembers.mockResolvedValue([athlete({ status: "ready" })]);
    const result = await syncRoster([app()], { now: NOW });
    expect(result.enabled).toBe(1);
    expect(m.putMember).toHaveBeenCalledWith(expect.objectContaining({ status: "active" }));
    expect(m.syncChannelMemberships).toHaveBeenCalledTimes(1);
    expect(m.enqueue).toHaveBeenCalledWith({ type: "welcome", sub: "u-1" });
  });

  it("leaves waiting athletes alone while it is off", async () => {
    m.listMembers.mockResolvedValue([athlete({ status: "ready" })]);
    const result = await syncRoster([app()], { now: NOW });
    expect(result.enabled).toBe(0);
    expect(m.putMember).not.toHaveBeenCalled();
  });

  it("never touches a disabled athlete", async () => {
    m.getSettings.mockResolvedValue(settings({ autoEnableAthletes: true, welcomeEmail: true }));
    m.listMembers.mockResolvedValue([athlete({ status: "disabled" })]);
    const result = await syncRoster([app()], { now: NOW });
    expect(result.enabled).toBe(0);
    expect(m.putMember).not.toHaveBeenCalled();
    expect(m.enqueue).not.toHaveBeenCalled();
  });
});

describe("the pending list", () => {
  it("drops someone who left the accepted list", async () => {
    m.listPending.mockResolvedValue([pendingRow({ applicationId: 99 })]);
    await syncRoster([app()], { now: NOW });
    expect(m.deletePending).toHaveBeenCalledWith(99);
    expect(m.deletePending).not.toHaveBeenCalledWith(7);
  });

  it("keeps every row when the roster comes back empty", async () => {
    m.listPending.mockResolvedValue([pendingRow()]);
    await syncRoster([], { now: NOW });
    expect(m.deletePending).not.toHaveBeenCalled();
  });

  it("keeps a row whose application failed, and finishes the rest", async () => {
    m.listPending.mockResolvedValue([pendingRow({ applicationId: 8 })]);
    m.findAccountByEmail.mockImplementation(async (email: string) => {
      if (email === "bad@example.edu") throw new Error("cognito down");
      return undefined;
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const result = await syncRoster([app({ id: 8, email: "bad@example.edu" }), app()], { now: NOW });
    errors.mockRestore();
    expect(result).toMatchObject({ failed: 1, noAccount: 1 });
    expect(m.deletePending).not.toHaveBeenCalled();
  });
});

describe("dry run", () => {
  it("counts what would change and writes nothing", async () => {
    m.getSettings.mockResolvedValue(settings({ autoEnableAthletes: true, welcomeEmail: true }));
    m.listMembers.mockResolvedValue([athlete({ status: "ready" })]);
    m.listPending.mockResolvedValue([pendingRow({ applicationId: 99 })]);
    const result = await syncRoster([app(), app({ id: 8, email: "new@example.edu" })], { now: NOW, dryRun: true });
    expect(result).toMatchObject({ dryRun: true, enabled: 1, noAccount: 1, invited: 1 });
    for (const write of [m.putMember, m.createMember, m.savePending, m.deletePending, m.claimInvite, m.enqueue, m.syncChannelMemberships]) {
      expect(write).not.toHaveBeenCalled();
    }
  });
});
