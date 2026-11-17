import { NotifyPrefs, type PendingAthlete, type PortalMember, PortalSettings } from "@niltv/types";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  getSettings: vi.fn(),
  listMembers: vi.fn(),
  getMember: vi.fn(),
  putMember: vi.fn(),
  createMember: vi.fn(),
  lookupEmail: vi.fn(),
  deleteUnfinished: vi.fn(),
  syncChannelMemberships: vi.fn(),
  enqueue: vi.fn(),
  enqueueOrThrow: vi.fn(),
  listPending: vi.fn(),
  savePending: vi.fn(),
  deletePending: vi.fn(),
  claimInvite: vi.fn(),
  releaseInvite: vi.fn(),
  findProfileIdByHandle: vi.fn(),
}));

vi.mock("../../lib/roster", () => ({ dashboardApiKey: async () => "key" }));
vi.mock("../../lib/portal/members", () => ({
  getSettings: m.getSettings,
  listMembers: m.listMembers,
  getMember: m.getMember,
  putMember: m.putMember,
  createMember: m.createMember,
}));
vi.mock("../../lib/portal/accounts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/portal/accounts")>()),
  lookupEmail: m.lookupEmail,
  deleteUnfinished: m.deleteUnfinished,
}));
vi.mock("../../lib/portal/conversations", () => ({ syncChannelMemberships: m.syncChannelMemberships }));
vi.mock("../../lib/portal/notify", () => ({ enqueue: m.enqueue, enqueueOrThrow: m.enqueueOrThrow }));
vi.mock("../../lib/portal/pending", () => ({
  INVITE_COOLDOWN_MS: 24 * 60 * 60 * 1000,
  listPending: m.listPending,
  savePending: m.savePending,
  deletePending: m.deletePending,
  claimInvite: m.claimInvite,
  releaseInvite: m.releaseInvite,
}));
vi.mock("../../lib/portal/profiles", () => ({ findProfileIdByHandle: m.findProfileIdByHandle }));

import { type AcceptedApplication, handler, syncRoster } from "./roster-sync";

const NOW = "2026-11-04T18:00:00.000Z";
const HOUR_AGO = "2026-11-04T17:00:00.000Z";
const TWO_DAYS_AGO = "2026-11-02T18:00:00.000Z";

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
const account = { sub: "u-1", email: "jordan.miles@example.edu" };

beforeEach(() => {
  vi.clearAllMocks();
  m.getSettings.mockResolvedValue(settings());
  m.listMembers.mockResolvedValue([]);
  m.getMember.mockResolvedValue(undefined);
  m.createMember.mockResolvedValue(true);
  m.lookupEmail.mockResolvedValue({ unfinished: [] });
  m.listPending.mockResolvedValue([]);
  m.claimInvite.mockResolvedValue(pendingRow({ invitedAt: NOW }));
  m.enqueueOrThrow.mockResolvedValue(undefined);
  m.syncChannelMemberships.mockResolvedValue({ joined: [], left: [] });
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
    expect(m.enqueueOrThrow).not.toHaveBeenCalled();
  });

  it("gets an invite once the emails are on", async () => {
    m.getSettings.mockResolvedValue(settings({ welcomeEmail: true }));
    const result = await syncRoster([app()], { now: NOW });
    expect(result.invited).toBe(1);
    expect(m.enqueueOrThrow).toHaveBeenCalledWith({ type: "invite", applicationId: 7 });
  });

  it("is not invited again once one really went out", async () => {
    m.getSettings.mockResolvedValue(settings({ welcomeEmail: true }));
    m.listPending.mockResolvedValue([pendingRow({ invitedAt: TWO_DAYS_AGO, sentAt: TWO_DAYS_AGO })]);
    const result = await syncRoster([app()], { now: NOW });
    expect(result.invited).toBe(0);
    expect(m.claimInvite).not.toHaveBeenCalled();
  });

  it("is tried again a day later when the last one never went out", async () => {
    m.getSettings.mockResolvedValue(settings({ welcomeEmail: true }));
    m.listPending.mockResolvedValue([pendingRow({ invitedAt: TWO_DAYS_AGO })]);
    const result = await syncRoster([app()], { now: NOW });
    expect(result.invited).toBe(1);
  });

  it("is not tried again the same day", async () => {
    m.getSettings.mockResolvedValue(settings({ welcomeEmail: true }));
    m.listPending.mockResolvedValue([pendingRow({ invitedAt: HOUR_AGO })]);
    const result = await syncRoster([app()], { now: NOW });
    expect(result.invited).toBe(0);
    expect(m.claimInvite).not.toHaveBeenCalled();
  });

  it("sends nothing when an admin claimed the invite first", async () => {
    m.getSettings.mockResolvedValue(settings({ welcomeEmail: true }));
    m.claimInvite.mockResolvedValue(undefined);
    const result = await syncRoster([app()], { now: NOW });
    expect(result.invited).toBe(0);
    expect(m.enqueueOrThrow).not.toHaveBeenCalled();
  });

  it("gives the claim back when the queue refuses, so the next run can try", async () => {
    m.getSettings.mockResolvedValue(settings({ welcomeEmail: true }));
    m.enqueueOrThrow.mockRejectedValue(new Error("sqs down"));
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const result = await syncRoster([app()], { now: NOW });
    errors.mockRestore();
    expect(result).toMatchObject({ invited: 0, failed: 1 });
    expect(m.releaseInvite).toHaveBeenCalledWith(7, new Date(NOW));
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

describe("a sign-up nobody finished", () => {
  const old = { username: "u-stuck", createdAt: new Date(TWO_DAYS_AGO) };
  const fresh = { username: "u-new", createdAt: new Date(HOUR_AGO) };

  it("is cleared after a day, so the address can sign up again", async () => {
    m.lookupEmail.mockResolvedValue({ unfinished: [old, fresh] });
    const result = await syncRoster([app()], { now: NOW });
    expect(result.cleared).toBe(1);
    expect(m.deleteUnfinished).toHaveBeenCalledWith([old]);
  });

  it("is left alone while its code can still work", async () => {
    m.lookupEmail.mockResolvedValue({ unfinished: [fresh] });
    await syncRoster([app()], { now: NOW });
    expect(m.deleteUnfinished).not.toHaveBeenCalled();
  });

  it("is only counted in a dry run", async () => {
    m.lookupEmail.mockResolvedValue({ unfinished: [old] });
    const result = await syncRoster([app()], { now: NOW, dryRun: true });
    expect(result.cleared).toBe(1);
    expect(m.deleteUnfinished).not.toHaveBeenCalled();
  });
});

describe("matching an account", () => {
  it("never uses the college email, which is free text", async () => {
    const typed = { ...app(), college_email: "someone.else@example.edu" };
    m.listMembers.mockResolvedValue([athlete({ sub: "u-other", email: "someone.else@example.edu", applicationId: undefined, name: "Someone Else" })]);
    const result = await syncRoster([typed], { now: NOW });
    expect(m.lookupEmail).toHaveBeenCalledTimes(1);
    expect(m.lookupEmail).toHaveBeenCalledWith("Jordan.Miles@Example.edu");
    expect(m.putMember).not.toHaveBeenCalled();
    expect(result.noAccount).toBe(1);
  });

  it("creates the member and clears the pending row in the same run", async () => {
    m.lookupEmail.mockResolvedValue({ account, unfinished: [] });
    m.listPending.mockResolvedValue([pendingRow({ invitedAt: TWO_DAYS_AGO })]);
    const result = await syncRoster([app()], { now: NOW });
    expect(result).toMatchObject({ created: 1, noAccount: 0 });
    expect(m.deletePending).toHaveBeenCalledWith(7);
  });

  it("lands new athletes as ready while auto-enable is off", async () => {
    m.lookupEmail.mockResolvedValue({ account, unfinished: [] });
    await syncRoster([app()], { now: NOW });
    expect(m.createMember).toHaveBeenCalledWith(expect.objectContaining({ status: "ready" }));
    expect(m.syncChannelMemberships).not.toHaveBeenCalled();
    expect(m.enqueue).not.toHaveBeenCalled();
  });

  it("releases a new athlete straight away when both switches are on", async () => {
    m.getSettings.mockResolvedValue(settings({ autoEnableAthletes: true, welcomeEmail: true }));
    m.lookupEmail.mockResolvedValue({ account, unfinished: [] });
    await syncRoster([app()], { now: NOW });
    expect(m.createMember).toHaveBeenCalledWith(expect.objectContaining({ status: "ready" }));
    expect(m.putMember).toHaveBeenCalledWith(expect.objectContaining({ status: "active" }));
    expect(m.syncChannelMemberships).toHaveBeenCalledTimes(1);
    expect(m.enqueue).toHaveBeenCalledWith({ type: "welcome", sub: "u-1" });
  });

  it("keeps staff who applied as staff and only records the link", async () => {
    m.listMembers.mockResolvedValue([athlete({ role: "staff", applicationId: undefined })]);
    await syncRoster([app()], { now: NOW });
    expect(m.putMember).toHaveBeenCalledWith(expect.objectContaining({ role: "staff", applicationId: 7 }));
    expect(m.syncChannelMemberships).not.toHaveBeenCalled();
  });

  it("finds an existing member by application id, even on another email, with no account lookup", async () => {
    m.listMembers.mockResolvedValue([athlete({ email: "jm@other.edu", sport: "Rowing" })]);
    const result = await syncRoster([app()], { now: NOW });
    expect(m.lookupEmail).not.toHaveBeenCalled();
    expect(result).toMatchObject({ updated: 1, created: 0 });
    expect(m.putMember).toHaveBeenCalledWith(expect.objectContaining({ sub: "u-1", sport: "Football", email: "jm@other.edu" }));
  });

  it("finds an existing member by email and links the application", async () => {
    m.listMembers.mockResolvedValue([athlete({ applicationId: undefined })]);
    const result = await syncRoster([app()], { now: NOW });
    expect(m.lookupEmail).not.toHaveBeenCalled();
    expect(result.updated).toBe(1);
    expect(m.putMember).toHaveBeenCalledWith(expect.objectContaining({ sub: "u-1", applicationId: 7 }));
  });

  it("leaves an existing member alone when nothing changed", async () => {
    m.listMembers.mockResolvedValue([athlete()]);
    const result = await syncRoster([app()], { now: NOW });
    expect(result).toMatchObject({ updated: 0, created: 0 });
    expect(m.putMember).not.toHaveBeenCalled();
  });

  it("never rewrites a member tied to a different application", async () => {
    m.listMembers.mockResolvedValue([athlete({ applicationId: 99, name: "Somebody Else", sport: "Rowing" })]);
    m.listPending.mockResolvedValue([pendingRow()]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const result = await syncRoster([app()], { now: NOW });
    warn.mockRestore();
    expect(result.conflicts).toBe(1);
    expect(m.putMember).not.toHaveBeenCalled();
    expect(m.deletePending).not.toHaveBeenCalled();
  });
});

describe("auto-enable", () => {
  it("releases athletes already waiting, joining channels before the status changes", async () => {
    m.getSettings.mockResolvedValue(settings({ autoEnableAthletes: true, welcomeEmail: true }));
    m.listMembers.mockResolvedValue([athlete({ status: "ready" })]);
    const result = await syncRoster([app()], { now: NOW });
    expect(result.enabled).toBe(1);
    expect(m.putMember).toHaveBeenCalledWith(expect.objectContaining({ status: "active" }));
    expect(m.syncChannelMemberships.mock.invocationCallOrder[0]!).toBeLessThan(m.putMember.mock.invocationCallOrder[0]!);
    expect(m.enqueue).toHaveBeenCalledWith({ type: "welcome", sub: "u-1" });
  });

  it("leaves the row ready when joining channels fails, so the next run redoes it", async () => {
    m.getSettings.mockResolvedValue(settings({ autoEnableAthletes: true, welcomeEmail: true }));
    m.listMembers.mockResolvedValue([athlete({ status: "ready" })]);
    m.syncChannelMemberships.mockRejectedValue(new Error("dynamo down"));
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const result = await syncRoster([app()], { now: NOW });
    errors.mockRestore();
    expect(result).toMatchObject({ enabled: 0, failed: 1 });
    expect(m.putMember).not.toHaveBeenCalled();
    expect(m.enqueue).not.toHaveBeenCalled();
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
    m.lookupEmail.mockImplementation(async (email: string) => {
      if (email === "bad@example.edu") throw new Error("cognito down");
      return { unfinished: [] };
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
    for (const write of [m.putMember, m.createMember, m.savePending, m.deletePending, m.claimInvite, m.enqueueOrThrow, m.syncChannelMemberships]) {
      expect(write).not.toHaveBeenCalled();
    }
  });

  it("lists who has no account, only in a dry run", async () => {
    const dry = await syncRoster([app()], { now: NOW, dryRun: true });
    expect(dry.unmatched).toEqual([{ applicationId: 7, name: "Jordan Miles" }]);
    const real = await syncRoster([app()], { now: NOW });
    expect(real.unmatched).toBeUndefined();
  });

  it("returns the names from an invoke and keeps them out of the log", async () => {
    process.env.DASHBOARD_API_URL = "https://dashboard.test";
    process.env.DASHBOARD_API_KEY_PARAM = "/key";
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => [app()] })));
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const result = await handler({ dryRun: true });
    const logged = log.mock.calls.map((c) => c.join(" ")).join("\n");
    log.mockRestore();
    vi.unstubAllGlobals();
    expect(result.unmatched).toEqual([{ applicationId: 7, name: "Jordan Miles" }]);
    expect(logged).toContain("noAccount");
    expect(logged).not.toContain("Jordan");
  });
});

describe("the scheduled run", () => {
  it("fails loudly when any application failed, so the Errors metric shows it", async () => {
    process.env.DASHBOARD_API_URL = "https://dashboard.test";
    process.env.DASHBOARD_API_KEY_PARAM = "/key";
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => [app()] })));
    m.lookupEmail.mockRejectedValue(new Error("no permission"));
    const quiet = [vi.spyOn(console, "error").mockImplementation(() => undefined), vi.spyOn(console, "log").mockImplementation(() => undefined)];
    await expect(handler()).rejects.toThrow("1 of 1 applications failed");
    quiet.forEach((s) => s.mockRestore());
    vi.unstubAllGlobals();
  });
});
