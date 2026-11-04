import { NotifyPrefs, type PortalMember, PortalSettings } from "@niltv/types";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  send: vi.fn(),
  getSettings: vi.fn(),
  getMembers: vi.fn(),
  getMember: vi.fn(),
  listMembers: vi.fn(),
  deskStaff: vi.fn(),
  deskRecipients: vi.fn(),
  getConv: vi.fn(),
  getMemberships: vi.fn(),
  memberSubs: vi.fn(),
  inbox: vi.fn(),
  queueSummary: vi.fn(),
  claimPushSlot: vi.fn(),
  listDevices: vi.fn(),
  pushTo: vi.fn(),
  sendEmail: vi.fn(),
  resolveAudience: vi.fn(),
  getPending: vi.fn(),
  markInviteSent: vi.fn(),
}));

vi.mock("../../lib/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/db")>()),
  getDocClient: () => ({ send: m.send }),
}));
vi.mock("../../lib/portal/members", () => ({
  getSettings: m.getSettings,
  getMembers: m.getMembers,
  getMember: m.getMember,
  listMembers: m.listMembers,
  deskStaff: m.deskStaff,
  deskRecipients: m.deskRecipients,
}));
vi.mock("../../lib/portal/conversations", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/portal/conversations")>()),
  getConv: m.getConv,
  getMemberships: m.getMemberships,
  memberSubs: m.memberSubs,
  inbox: m.inbox,
}));
vi.mock("../../lib/portal/activity", () => ({ queueSummary: m.queueSummary, claimPushSlot: m.claimPushSlot }));
vi.mock("../../lib/portal/push", () => ({ listDevices: m.listDevices, pushTo: m.pushTo }));
vi.mock("../../lib/portal/emails", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/portal/emails")>()),
  sendEmail: m.sendEmail,
}));
vi.mock("../../lib/portal/audience", () => ({ resolveAudience: m.resolveAudience }));
vi.mock("../../lib/portal/pending", () => ({ getPending: m.getPending, markInviteSent: m.markInviteSent }));

import { handleNotice } from "./notify";

/** 3 PM New York, a weekday. */
const NOW = new Date("2026-10-21T19:00:00.000Z");

const person = (sub: string, over: Partial<PortalMember> = {}): PortalMember => ({
  sub,
  email: `${sub}@example.com`,
  name: `Person ${sub}`,
  role: "athlete",
  status: "active",
  desks: [],
  edited: [],
  notify: NotifyPrefs.parse({}),
  createdAt: "2026-10-01T00:00:00.000Z",
  timezone: "America/New_York",
  ...over,
});

const membership = (over: Record<string, unknown> = {}) => ({
  convId: "grp-1",
  kind: "group",
  lastReadSeq: 4,
  muted: false,
  marker: false,
  mentionSeq: 0,
  ...over,
});

const group = { id: "grp-1", kind: "group", title: "Duke crew", about: "", staffOnly: false, memberCount: 3, seq: 5, createdAt: "2026-10-01T00:00:00.000Z" };
const announcements = { ...group, id: "ch-announcements", kind: "channel", title: "Announcements", scope: { type: "announcements" }, staffOnly: true };

const messageRow = (over: Record<string, unknown> = {}) => ({
  Item: {
    authorSub: "u-author",
    authorName: "Person u-author",
    authorRole: "athlete",
    seq: 5,
    body: "Practice moved to 6.",
    at: NOW.toISOString(),
    ...over,
  },
});

function settings(over: Partial<PortalSettings> = {}): PortalSettings {
  return PortalSettings.parse({ activityEmails: true, webPush: true, ...over });
}

beforeEach(() => {
  for (const fn of Object.values(m)) fn.mockReset();
  process.env.TABLE_NAME = "niltv-test";
  m.getSettings.mockResolvedValue(settings());
  m.listDevices.mockResolvedValue([{ id: "d1" }]);
  m.claimPushSlot.mockResolvedValue(true);
  m.pushTo.mockResolvedValue(1);
  m.inbox.mockResolvedValue([]);
});

describe("message notices", () => {
  it("do nothing while both switches are off", async () => {
    m.getSettings.mockResolvedValue(settings({ activityEmails: false, webPush: false }));
    await handleNotice({ type: "message", convId: "grp-1", messageId: "01J", seq: 5 }, NOW);
    expect(m.getConv).not.toHaveBeenCalled();
    expect(m.queueSummary).not.toHaveBeenCalled();
    expect(m.pushTo).not.toHaveBeenCalled();
  });

  it("queue and push group members who have not read it, skipping the muted and the caught up", async () => {
    m.getConv.mockResolvedValue(group);
    m.send.mockResolvedValue(messageRow());
    m.memberSubs.mockResolvedValue(["u-author", "u-a", "u-muted", "u-read"]);
    m.getMembers.mockResolvedValue(new Map(["u-a", "u-muted", "u-read"].map((s) => [s, person(s)])));
    m.getMemberships.mockResolvedValue(
      new Map([
        ["u-a", membership()],
        ["u-muted", membership({ muted: true })],
        ["u-read", membership({ lastReadSeq: 5 })],
      ]),
    );
    await handleNotice({ type: "message", convId: "grp-1", messageId: "01J", seq: 5 }, NOW);
    expect(m.queueSummary).toHaveBeenCalledTimes(1);
    expect(m.queueSummary.mock.calls[0]![0].sub).toBe("u-a");
    expect(m.queueSummary.mock.calls[0]![1]).toMatchObject({ cadence: "now" });
    expect(m.pushTo).toHaveBeenCalledTimes(1);
    const payload = m.pushTo.mock.calls[0]![1];
    expect(payload).toMatchObject({ title: "Duke crew", url: "/messages/grp-1", tag: "conv-grp-1" });
    expect(payload.body).toBe("Person u-author: Practice moved to 6.");
  });

  it("let a mention through a muted thread as a direct message", async () => {
    m.getConv.mockResolvedValue(group);
    m.send.mockResolvedValue(messageRow({ mentions: ["u-muted"] }));
    m.memberSubs.mockResolvedValue(["u-author", "u-muted"]);
    m.getMembers.mockResolvedValue(new Map([["u-muted", person("u-muted", { notify: { ...NotifyPrefs.parse({}), groups: "off", previews: false } })]]));
    m.getMemberships.mockResolvedValue(new Map([["u-muted", membership({ muted: true })]]));
    await handleNotice({ type: "message", convId: "grp-1", messageId: "01J", seq: 5 }, NOW);
    expect(m.pushTo).toHaveBeenCalledTimes(1);
    expect(m.pushTo.mock.calls[0]![1].body).toBe("Person u-author mentioned you");
    // Direct pushes skip the daily cap.
    expect(m.claimPushSlot).not.toHaveBeenCalled();
  });

  it("hold the push when the member is in the portal now, but still queue the summary", async () => {
    m.getConv.mockResolvedValue(group);
    m.send.mockResolvedValue(messageRow());
    m.memberSubs.mockResolvedValue(["u-a"]);
    m.getMembers.mockResolvedValue(new Map([["u-a", person("u-a", { lastSeenAt: new Date(NOW.getTime() - 60_000).toISOString() })]]));
    m.getMemberships.mockResolvedValue(new Map([["u-a", membership()]]));
    await handleNotice({ type: "message", convId: "grp-1", messageId: "01J", seq: 5 }, NOW);
    expect(m.queueSummary).toHaveBeenCalledTimes(1);
    expect(m.pushTo).not.toHaveBeenCalled();
  });

  it("email an important announcement right away instead of queueing it", async () => {
    m.getConv.mockResolvedValue(announcements);
    m.send.mockResolvedValue(messageRow({ authorRole: "staff", important: true }));
    m.memberSubs.mockResolvedValue(["u-a", "u-off"]);
    m.getMembers.mockResolvedValue(
      new Map([
        ["u-a", person("u-a")],
        ["u-off", person("u-off", { notify: { ...NotifyPrefs.parse({}), announcements: "off" } })],
      ]),
    );
    m.getMemberships.mockResolvedValue(new Map());
    await handleNotice({ type: "message", convId: "ch-announcements", messageId: "01J", seq: 5 }, NOW);
    expect(m.sendEmail).toHaveBeenCalledTimes(1);
    expect(m.sendEmail.mock.calls[0]![0]).toBe("u-a@example.com");
    expect(m.sendEmail.mock.calls[0]![1].subject).toBe("Important announcement from NIL TV");
    expect(JSON.stringify(m.sendEmail.mock.calls[0]![1])).not.toContain("Practice moved");
    expect(m.queueSummary).not.toHaveBeenCalled();
  });

  it("ignore the important flag from anyone but staff", async () => {
    m.getConv.mockResolvedValue(announcements);
    m.send.mockResolvedValue(messageRow({ important: true }));
    m.memberSubs.mockResolvedValue(["u-a"]);
    m.getMembers.mockResolvedValue(new Map([["u-a", person("u-a")]]));
    m.getMemberships.mockResolvedValue(new Map());
    await handleNotice({ type: "message", convId: "ch-announcements", messageId: "01J", seq: 5 }, NOW);
    expect(m.sendEmail).not.toHaveBeenCalled();
    expect(m.queueSummary).toHaveBeenCalledTimes(1);
  });

  it("push the desk's staff when an athlete writes in, and queue no summary", async () => {
    m.getConv.mockResolvedValue({ ...group, id: "desk-support-u-author", kind: "desk", desk: "support", personSub: "u-author", personName: "Person u-author" });
    m.send.mockResolvedValue(messageRow());
    m.deskStaff.mockResolvedValue([person("u-staff", { role: "staff", desks: ["support"] }), person("u-caught-up", { role: "staff", desks: ["support"] })]);
    m.getMemberships.mockResolvedValue(new Map([["u-caught-up", membership({ lastReadSeq: 5, marker: true })]]));
    await handleNotice({ type: "message", convId: "desk-support-u-author", messageId: "01J", seq: 5 }, NOW);
    expect(m.pushTo).toHaveBeenCalledTimes(1);
    expect(m.pushTo.mock.calls[0]![0]).toBe("u-staff");
    expect(m.pushTo.mock.calls[0]![1]).toMatchObject({ title: "Person u-author", body: "Practice moved to 6." });
    expect(m.queueSummary).not.toHaveBeenCalled();
  });

  it("sign a staff reply as the desk for the athlete", async () => {
    m.getConv.mockResolvedValue({ ...group, id: "desk-support-u-a", kind: "desk", desk: "support", personSub: "u-a", personName: "Person u-a" });
    m.send.mockResolvedValue(messageRow({ authorSub: "u-staff", authorName: "Pat Staff", authorRole: "staff" }));
    m.getMembers.mockResolvedValue(new Map([["u-a", person("u-a")]]));
    m.getMemberships.mockResolvedValue(new Map([["u-a", membership({ convId: "desk-support-u-a", kind: "desk" })]]));
    await handleNotice({ type: "message", convId: "desk-support-u-a", messageId: "01J", seq: 5 }, NOW);
    expect(m.pushTo.mock.calls[0]![1]).toMatchObject({ title: "Athlete support", body: "Athlete support: Practice moved to 6." });
    expect(JSON.stringify(m.pushTo.mock.calls[0]![1])).not.toContain("Pat Staff");
  });
});

describe("schedule notices", () => {
  const event = (startsAt: string) => ({
    Item: {
      id: "ev-1",
      title: "Media day",
      kind: "shoot",
      status: "cancelled",
      options: [{ id: "o-1", startsAt }],
      lockedOptionId: "o-1",
      audience: { type: "everyone" },
    },
  });

  it("email a cancellation within 48 hours right away", async () => {
    m.send.mockResolvedValue(event(new Date(NOW.getTime() + 20 * 3600_000).toISOString()));
    m.resolveAudience.mockResolvedValue([person("u-a")]);
    await handleNotice({ type: "event.cancelled", eventId: "ev-1" }, NOW);
    expect(m.sendEmail).toHaveBeenCalledTimes(1);
    expect(m.sendEmail.mock.calls[0]![1].subject).toBe("Cancelled: Media day");
    expect(m.queueSummary).not.toHaveBeenCalled();
  });

  it("put a later cancellation in the summary as a note", async () => {
    m.send.mockResolvedValue(event(new Date(NOW.getTime() + 10 * 86400_000).toISOString()));
    m.resolveAudience.mockResolvedValue([person("u-a")]);
    await handleNotice({ type: "event.cancelled", eventId: "ev-1" }, NOW);
    expect(m.sendEmail).not.toHaveBeenCalled();
    expect(m.queueSummary.mock.calls[0]![1].note).toMatchObject({ topic: "schedule", text: "Cancelled: Media day" });
  });
});

describe("account invites", () => {
  const row = { applicationId: 7, email: "jordan+nil@example.edu", name: "Jordan Miles", firstSeenAt: "2026-11-01T00:00:00.000Z" };

  it("names the exact address and links to the create-account step with it filled in", async () => {
    m.getPending.mockResolvedValue(row);
    m.sendEmail.mockResolvedValue(true);
    await handleNotice({ type: "invite", applicationId: 7 }, NOW);
    const [to, email] = m.sendEmail.mock.calls[0]!;
    expect(to).toBe("jordan+nil@example.edu");
    expect(email.paragraphs.join(" ")).toContain("jordan+nil@example.edu");
    expect(email.button.path).toBe("/create-account?email=jordan%2Bnil%40example.edu");
    expect(m.markInviteSent).toHaveBeenCalledWith(7, NOW);
  });

  it("sends nothing once the person has an account", async () => {
    m.getPending.mockResolvedValue(undefined);
    await handleNotice({ type: "invite", applicationId: 7 }, NOW);
    expect(m.sendEmail).not.toHaveBeenCalled();
  });

  it("throws on a failed send, so the queue retries and the dead-letter queue keeps it", async () => {
    m.getPending.mockResolvedValue(row);
    m.sendEmail.mockResolvedValue(false);
    await expect(handleNotice({ type: "invite", applicationId: 7 }, NOW)).rejects.toThrow("invite email failed");
    expect(m.markInviteSent).not.toHaveBeenCalled();
  });

  it("does not retry a skipped test address", async () => {
    m.getPending.mockResolvedValue({ ...row, email: "smoke@niltv.invalid" });
    m.sendEmail.mockResolvedValue(false);
    await expect(handleNotice({ type: "invite", applicationId: 7 }, NOW)).resolves.toBeUndefined();
  });
});

describe("staff work queues", () => {
  it("still email page change requests with both switches off", async () => {
    m.getSettings.mockResolvedValue(settings({ activityEmails: false, webPush: false }));
    m.send.mockResolvedValue({ Item: { id: "req-1", personName: "Person u-a", body: "Fix my bio." } });
    m.deskRecipients.mockResolvedValue(["desk@example.com"]);
    await handleNotice({ type: "request.new", requestId: "req-1" }, NOW);
    expect(m.sendEmail).toHaveBeenCalledWith("desk@example.com", expect.objectContaining({ subject: "Page change request from Person u-a" }));
  });
});
