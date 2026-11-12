import { NotifyPrefs, type PortalMember, PortalSettings } from "@niltv/types";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  send: vi.fn(),
  getSettings: vi.fn(),
  getMember: vi.fn(),
  deskRecipients: vi.fn(),
  waitingDeskThreads: vi.fn(),
  settleSummary: vi.fn(),
  gatherSummary: vi.fn(),
  sendEmail: vi.fn(),
}));

vi.mock("../../lib/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/db")>()),
  getDocClient: () => ({ send: m.send }),
}));
vi.mock("../../lib/portal/members", () => ({
  getSettings: m.getSettings,
  getMember: m.getMember,
  deskRecipients: m.deskRecipients,
}));
vi.mock("../../lib/portal/conversations", () => ({ waitingDeskThreads: m.waitingDeskThreads }));
vi.mock("../../lib/portal/activity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/portal/activity")>()),
  settleSummary: m.settleSummary,
}));
vi.mock("../../lib/portal/summary", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/portal/summary")>()),
  gatherSummary: m.gatherSummary,
}));
vi.mock("../../lib/portal/emails", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/portal/emails")>()),
  sendEmail: m.sendEmail,
}));

import { type SummaryContent, deskAlertEmail, summaryEmail } from "../../lib/portal/summary";
import { sweep } from "./summary";

/** 3 PM New York. */
const NOW = new Date("2026-10-21T19:00:00.000Z");

const person = (over: Partial<PortalMember> = {}): PortalMember => ({
  sub: "u-1",
  email: "a@example.com",
  name: "Jordan M.",
  role: "athlete",
  status: "active",
  desks: [],
  edited: [],
  notify: NotifyPrefs.parse({}),
  createdAt: "2026-10-01T00:00:00.000Z",
  timezone: "America/New_York",
  ...over,
});

const content = (over: Partial<SummaryContent> = {}): SummaryContent => ({
  threads: [],
  polls: [],
  events: [],
  postings: [],
  notes: [],
  ...over,
});

const dueRow = { PK: "USER#u-1", SK: "NOTIFY", pendingSince: "2026-10-21T17:00:00.000Z", dueAt: "2026-10-21T18:00:00.000Z", rev: 3 };

/** Route the fake table by command: due-row query, consistent get, desk state get. */
function table(rows: { due?: unknown[]; state?: unknown; desk?: unknown } = {}): void {
  m.send.mockImplementation(async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
    const name = cmd.constructor.name;
    if (name === "QueryCommand") return { Items: rows.due ?? [] };
    if (name === "GetCommand") {
      const key = cmd.input["Key"] as { PK: string };
      return { Item: key.PK === "PORTAL#NOTIFY" ? rows.desk : rows.state };
    }
    return {};
  });
}

beforeEach(() => {
  for (const fn of Object.values(m)) fn.mockReset();
  process.env.TABLE_NAME = "niltv-test";
  m.getSettings.mockResolvedValue(PortalSettings.parse({ activityEmails: true }));
  m.settleSummary.mockResolvedValue(true);
  m.sendEmail.mockResolvedValue(true);
  m.deskRecipients.mockResolvedValue([]);
  m.waitingDeskThreads.mockResolvedValue([]);
});

describe("the summary email", () => {
  it("counts messages, never quotes them, and lists what waits", () => {
    const email = summaryEmail(
      person(),
      content({
        threads: [
          { title: "Duke crew", unread: 3, mentioned: true },
          { title: "Athlete support", unread: 1, mentioned: false },
        ],
        polls: [{ title: "Media day", path: "/schedule/ev-1" }],
      }),
      { weekly: false, last: false },
    );
    expect(email.subject).toBe("4 unread messages and 1 more in the NIL TV Portal");
    expect(email.rows?.map((r) => r.label)).toEqual(["Duke crew", "Athlete support", "Pick your times: Media day"]);
    expect(email.rows?.[0]?.detail).toBe("3 new, including an @mention of you");
    expect(email.rows?.[1]?.detail).toBe("1 new message");
    expect(email.button?.path).toBe("/messages");
  });

  it("says when it slows down or stops", () => {
    const weekly = summaryEmail(person(), content({ notes: [{ topic: "direct", text: "You're approved for X", path: "/", at: NOW.toISOString() }] }), { weekly: true, last: false });
    expect(weekly.subject).toBe("1 thing waiting for you in the NIL TV Portal");
    expect(weekly.tail).toContain("these now come once a week");
    expect(summaryEmail(person(), content({ postings: [{ title: "Gaming night", path: "/postings/p" }] }), { weekly: true, last: true }).tail).toContain(
      "This is the last summary until you open the portal again.",
    );
  });

  it("caps a long list", () => {
    const threads = Array.from({ length: 20 }, (_, i) => ({ title: `Thread ${i}`, unread: 1, mentioned: false }));
    const email = summaryEmail(person(), content({ threads }), { weekly: false, last: false });
    expect(email.rows).toHaveLength(13);
    expect(email.rows?.at(-1)?.label).toBe("And 8 more in the portal.");
  });

  it("words desk alerts for one person and for several", () => {
    const one = deskAlertEmail("support", [{ personName: "Jordan M.", waitingSince: NOW.toISOString() }], "new");
    expect(one.subject).toBe("Jordan M. is waiting on Athlete support");
    const many = deskAlertEmail("content", [
      { personName: "A", waitingSince: NOW.toISOString() },
      { personName: "B", waitingSince: NOW.toISOString() },
    ], "morning");
    expect(many.subject).toBe("2 desk threads have waited more than a day");
  });
});

describe("the sweep", () => {
  it("drops due summaries while activity emails are off, and sends nothing", async () => {
    m.getSettings.mockResolvedValue(PortalSettings.parse({ activityEmails: false }));
    table({ due: [dueRow], state: dueRow });
    m.getMember.mockResolvedValue(person());
    const result = await sweep(NOW);
    expect(result).toMatchObject({ sent: 0, dropped: 1 });
    expect(m.settleSummary).toHaveBeenCalledWith("u-1", 3, { action: "drop" });
    expect(m.sendEmail).not.toHaveBeenCalled();
  });

  it("sends a due summary and records it", async () => {
    table({ due: [dueRow], state: dueRow });
    m.getMember.mockResolvedValue(person());
    m.gatherSummary.mockResolvedValue(content({ threads: [{ title: "Duke crew", unread: 2, mentioned: false }] }));
    const result = await sweep(NOW);
    expect(result.sent).toBe(1);
    expect(m.sendEmail.mock.calls[0]![0]).toBe("a@example.com");
    expect(m.settleSummary).toHaveBeenCalledWith("u-1", 3, { action: "sent", at: NOW, ignored: 0 });
  });

  it("keeps a summary SES refused due, and tries again in an hour", async () => {
    table({ due: [dueRow], state: dueRow });
    m.getMember.mockResolvedValue(person());
    m.gatherSummary.mockResolvedValue(content({ threads: [{ title: "Duke crew", unread: 2, mentioned: false }] }));
    m.sendEmail.mockResolvedValue(false);
    const result = await sweep(NOW);
    expect(result).toMatchObject({ sent: 0, failed: 1 });
    expect(m.settleSummary).toHaveBeenCalledWith("u-1", 3, { action: "wait", until: new Date("2026-10-21T20:00:00.000Z") });
  });

  it("drops a summary for a reserved test address without sending", async () => {
    table({ due: [dueRow], state: dueRow });
    m.getMember.mockResolvedValue(person({ email: "smoke@niltv.invalid" }));
    m.gatherSummary.mockResolvedValue(content({ threads: [{ title: "Duke crew", unread: 2, mentioned: false }] }));
    const result = await sweep(NOW);
    expect(result).toMatchObject({ sent: 0, dropped: 1 });
    expect(m.sendEmail).not.toHaveBeenCalled();
  });

  it("drops it when the member came back after it started", async () => {
    table({ due: [dueRow], state: dueRow });
    m.getMember.mockResolvedValue(person({ lastSeenAt: "2026-10-21T17:30:00.000Z" }));
    await sweep(NOW);
    expect(m.gatherSummary).not.toHaveBeenCalled();
    expect(m.settleSummary).toHaveBeenCalledWith("u-1", 3, { action: "drop" });
  });

  it("drops it when nothing is left to say", async () => {
    table({ due: [dueRow], state: dueRow });
    m.getMember.mockResolvedValue(person());
    m.gatherSummary.mockResolvedValue(content());
    await sweep(NOW);
    expect(m.sendEmail).not.toHaveBeenCalled();
    expect(m.settleSummary).toHaveBeenCalledWith("u-1", 3, { action: "drop" });
  });

  it("alerts a desk when a thread starts waiting, at most hourly", async () => {
    m.deskRecipients.mockImplementation(async (desk: string) => (desk === "support" ? ["desk@example.com"] : []));
    m.waitingDeskThreads.mockResolvedValue([{ personName: "Jordan M.", waitingSince: "2026-10-21T18:40:00.000Z" }]);
    table({ desk: { lastAlertAt: "2026-10-21T18:30:00.000Z", morningDay: "2026-10-21" } });
    expect((await sweep(NOW)).deskAlerts).toBe(0);

    table({ desk: { lastAlertAt: "2026-10-21T17:30:00.000Z", morningDay: "2026-10-21" } });
    expect((await sweep(NOW)).deskAlerts).toBe(1);
    expect(m.sendEmail).toHaveBeenCalledWith("desk@example.com", expect.objectContaining({ subject: "Jordan M. is waiting on Athlete support" }));
  });

  it("sends no desk alert during quiet hours", async () => {
    m.deskRecipients.mockResolvedValue(["desk@example.com"]);
    m.waitingDeskThreads.mockResolvedValue([{ personName: "Jordan M.", waitingSince: "2026-10-21T01:00:00.000Z" }]);
    table({ desk: {} });
    expect((await sweep(new Date("2026-10-22T03:00:00.000Z"))).deskAlerts).toBe(0);
  });
});
