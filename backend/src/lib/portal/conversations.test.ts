import { PortalMember } from "@niltv/types";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sendMock = vi.hoisted(() => vi.fn());

vi.mock("../db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../db")>();
  return { ...actual, getDocClient: () => ({ send: sendMock }), backoffDelayMs: () => 0 };
});

import {
  type ConvMeta,
  channelId,
  channelScopesFor,
  convAccess,
  presentMessage,
  sendMessage,
  setHidden,
  summarize,
} from "./conversations";

const member = (over: Partial<PortalMember> = {}): PortalMember =>
  PortalMember.parse({
    sub: "u-ath",
    email: "a@example.com",
    name: "Jordan M.",
    role: "athlete",
    status: "active",
    createdAt: "2026-10-01T00:00:00.000Z",
    ...over,
  });

const conv = (over: Partial<ConvMeta> = {}): ConvMeta => ({
  id: "ch-everyone",
  kind: "channel",
  title: "All athletes",
  about: "",
  staffOnly: false,
  memberCount: 10,
  seq: 5,
  createdAt: "2026-10-01T00:00:00.000Z",
  ...over,
});

const deskConv = (desk: "content" | "support" | "payments", personSub = "u-ath"): ConvMeta =>
  conv({ id: `desk-${desk}-${personSub}`, kind: "desk", title: desk, desk, personSub, personName: "Jordan M.", personRole: "athlete" });

const membership = { convId: "ch-everyone", kind: "channel" as const, lastReadSeq: 2, muted: false, marker: false, mentionSeq: 0 };

describe("channels", () => {
  it("slugs sport channels from the form's sport names", () => {
    expect(channelId({ type: "sport", sport: "Women's Basketball" })).toBe("ch-sport-womens-basketball");
    expect(channelId({ type: "sport", sport: "Men's Basketball" })).toBe("ch-sport-mens-basketball");
    expect(channelId({ type: "campus", campus: "truebluetv" })).toBe("ch-campus-truebluetv");
  });

  it("puts an active athlete in announcements, everyone, their campus and their sport", () => {
    const scopes = channelScopesFor(member({ campus: "truebluetv", sport: "Women's Basketball" }));
    expect(scopes.map(channelId)).toEqual([
      "ch-announcements",
      "ch-everyone",
      "ch-campus-truebluetv",
      "ch-sport-womens-basketball",
    ]);
  });

  it("skips an unknown campus and the Other sport", () => {
    const scopes = channelScopesFor(member({ campus: "no", sport: "Other" }));
    expect(scopes.map(channelId)).toEqual(["ch-announcements", "ch-everyone"]);
  });

  it("gives guests, staff and inactive athletes no channels", () => {
    expect(channelScopesFor(member({ role: "guest" }))).toEqual([]);
    expect(channelScopesFor(member({ role: "staff" }))).toEqual([]);
    expect(channelScopesFor(member({ status: "ready" }))).toEqual([]);
    expect(channelScopesFor(member({ status: "disabled" }))).toEqual([]);
  });
});

describe("convAccess", () => {
  it("lets members read and post in channels, but not post in staff-only ones", () => {
    expect(convAccess(member(), conv(), membership)).toMatchObject({ read: true, post: true });
    expect(convAccess(member(), conv({ staffOnly: true }), membership)).toMatchObject({ read: true, post: false });
  });

  it("refuses a channel or group the athlete is not a member of", () => {
    expect(convAccess(member(), conv(), undefined)).toMatchObject({ read: false, post: false });
    expect(convAccess(member(), conv({ kind: "group" }), { ...membership, marker: true })).toMatchObject({ read: false });
  });

  it("limits a desk thread to its own person on the athlete side", () => {
    expect(convAccess(member(), deskConv("support"), undefined)).toMatchObject({ read: true, post: true });
    expect(convAccess(member({ sub: "u-other" }), deskConv("support"), undefined)).toMatchObject({ read: false });
  });

  it("keeps the payments desk to admins", () => {
    expect(convAccess(member({ sub: "s", role: "staff" }), deskConv("payments"), undefined).read).toBe(false);
    expect(convAccess(member({ sub: "s", role: "staff" }), deskConv("content"), undefined).read).toBe(true);
    expect(convAccess(member({ sub: "a", role: "admin" }), deskConv("payments"), undefined).read).toBe(true);
  });

  it("lets staff read and post everywhere outside desks", () => {
    expect(convAccess(member({ sub: "s", role: "staff" }), conv({ staffOnly: true }), undefined)).toMatchObject({
      read: true,
      post: true,
      staff: true,
    });
  });
});

describe("presentMessage", () => {
  const stored = {
    id: "01J",
    convId: "ch-everyone",
    seq: 3,
    authorSub: "u-staff",
    authorName: "Pat Staff",
    authorRole: "staff" as const,
    body: "Game day content is due Sunday.",
    at: "2026-10-01T00:00:00.000Z",
    hidden: false,
    mentions: ["u-ath"],
    important: false,
  };

  it("signs staff posts as the team for athletes, with no staff name", () => {
    const out = presentMessage(stored, member(), conv());
    expect(out.authorName).toBe("NIL TV Team");
    expect(out.staffName).toBeUndefined();
  });

  it("signs desk replies with the desk name", () => {
    expect(presentMessage(stored, member(), deskConv("support")).authorName).toBe("Athlete support");
  });

  it("shows staff who wrote it", () => {
    const out = presentMessage(stored, member({ sub: "u-other-staff", role: "staff" }), conv());
    expect(out.staffName).toBe("Pat Staff");
  });

  it("blanks hidden messages for everyone but staff", () => {
    const hidden = { ...stored, authorRole: "athlete" as const, hidden: true };
    expect(presentMessage(hidden, member(), conv()).body).toBe("");
    expect(presentMessage(hidden, member({ sub: "s", role: "admin" }), conv()).body).toBe(stored.body);
  });

  it("drops a hidden message's mentions for everyone but staff", () => {
    const hidden = { ...stored, hidden: true };
    expect(presentMessage(stored, member(), conv()).mentions).toEqual(["u-ath"]);
    expect(presentMessage(hidden, member(), conv()).mentions).toEqual([]);
  });

  it("gives staff the author's account email on desk threads only", () => {
    const fromAthlete = { ...stored, authorSub: "u-ath", authorName: "NIL TV Team", authorRole: "athlete" as const };
    const emails = new Map([["u-ath", "a@example.com"]]);
    const staff = member({ sub: "u-staff2", role: "staff" });
    expect(presentMessage(fromAthlete, staff, deskConv("support"), emails).authorEmail).toBe("a@example.com");
    expect(presentMessage(fromAthlete, member(), deskConv("support"), emails).authorEmail).toBeUndefined();
    expect(presentMessage(fromAthlete, staff, conv(), emails).authorEmail).toBeUndefined();
  });
});

describe("summarize", () => {
  it("names a desk thread by the desk for athletes and by the person for staff", () => {
    expect(summarize(deskConv("content"), member(), undefined).title).toBe("Content team");
    const staffView = summarize(deskConv("content"), member({ sub: "s", role: "staff" }), undefined);
    expect(staffView.title).toBe("Jordan M.");
    expect(staffView.person?.sub).toBe("u-ath");
  });

  it("counts unread from the read marker", () => {
    expect(summarize(conv({ seq: 7 }), member(), { ...membership, lastReadSeq: 4 }).unread).toBe(3);
    // staff who never opened a channel start at zero; desk threads count in full
    expect(summarize(conv({ seq: 7 }), member({ sub: "s", role: "staff" }), undefined).unread).toBe(0);
    expect(summarize({ ...deskConv("content"), seq: 2 }, member({ sub: "s", role: "staff" }), undefined).unread).toBe(2);
  });

  it("flags an unread @mention until it is read", () => {
    expect(summarize(conv({ seq: 7 }), member(), { ...membership, lastReadSeq: 4, mentionSeq: 6 }).mentioned).toBe(true);
    expect(summarize(conv({ seq: 7 }), member(), { ...membership, lastReadSeq: 6, mentionSeq: 6 }).mentioned).toBe(false);
    expect(summarize(conv({ seq: 7 }), member(), { ...membership, lastReadSeq: 4 }).mentioned).toBe(false);
  });
});

describe("sendMessage", () => {
  beforeEach(() => {
    sendMock.mockReset();
    process.env.TABLE_NAME = "niltv-test";
  });

  const metaItem = (seq: number) => ({ Item: { id: "ch-everyone", kind: "channel", title: "All athletes", seq } });

  it("writes the guard, the message and the seq bump in one transaction", async () => {
    sendMock.mockResolvedValueOnce(metaItem(4)).mockResolvedValue({});
    const out = await sendMessage(member(), "ch-everyone", { clientMsgId: "client-123", body: "hello" });
    expect(out.duplicate).toBe(false);
    expect(out.message?.seq).toBe(5);
    const tx = sendMock.mock.calls[1]![0].input.TransactItems;
    expect(tx[0].Put.Item.SK).toBe("CMID#client-123");
    expect(tx[1].Put.Item).toMatchObject({ PK: "CONV#ch-everyone", seq: 5, body: "hello", authorSub: "u-ath" });
    expect(tx[2].Update.ConditionExpression).toBe("seq = :cur");
    expect(tx[2].Update.ExpressionAttributeValues).toMatchObject({ ":cur": 4, ":next": 5 });
  });

  it("returns duplicate when the client message id was already used", async () => {
    sendMock.mockResolvedValueOnce(metaItem(4)).mockRejectedValueOnce(
      Object.assign(new Error("cancelled"), {
        name: "TransactionCanceledException",
        CancellationReasons: [{ Code: "ConditionalCheckFailed" }, { Code: "None" }, { Code: "None" }],
      }),
    );
    const out = await sendMessage(member(), "ch-everyone", { clientMsgId: "client-123", body: "hello" });
    expect(out).toEqual({ duplicate: true });
  });

  it("re-reads and retries when another send moved seq first", async () => {
    sendMock
      .mockResolvedValueOnce(metaItem(4))
      .mockRejectedValueOnce(
        Object.assign(new Error("cancelled"), {
          name: "TransactionCanceledException",
          CancellationReasons: [{ Code: "None" }, { Code: "None" }, { Code: "ConditionalCheckFailed" }],
        }),
      )
      .mockResolvedValueOnce(metaItem(5))
      .mockResolvedValue({});
    const out = await sendMessage(member(), "ch-everyone", { clientMsgId: "client-123", body: "hello" });
    expect(out.message?.seq).toBe(6);
  });
});

describe("setHidden", () => {
  beforeEach(() => {
    sendMock.mockReset();
    sendMock.mockResolvedValue({});
  });

  it("names the hidden attribute through a placeholder (reserved word)", async () => {
    expect(await setHidden("ch-everyone", "01J", true, "u-staff")).toBe(true);
    const input = sendMock.mock.calls[0]![0].input;
    expect(input.UpdateExpression).not.toMatch(/SET hidden/);
    expect(input.ExpressionAttributeNames).toEqual({ "#hidden": "hidden" });
  });

  const row = (hidden: boolean) => ({ id: "01J", convId: "ch-everyone", seq: 5, body: "call me  at\n555", hidden });

  it("replaces the inbox preview when the newest message is hidden", async () => {
    sendMock.mockResolvedValueOnce({ Attributes: row(true) }).mockResolvedValueOnce({});
    expect(await setHidden("ch-everyone", "01J", true, "u-staff")).toBe(true);
    const meta = sendMock.mock.calls[1]![0].input;
    expect(meta.Key).toEqual({ PK: "CONV#ch-everyone", SK: "META" });
    expect(meta.ConditionExpression).toBe("seq = :seq");
    expect(meta.ExpressionAttributeValues).toEqual({ ":preview": "Hidden by staff", ":seq": 5 });
  });

  it("restores the preview on unhide", async () => {
    sendMock.mockResolvedValueOnce({ Attributes: row(false) }).mockResolvedValueOnce({});
    await setHidden("ch-everyone", "01J", false, "u-staff");
    expect(sendMock.mock.calls[1]![0].input.ExpressionAttributeValues[":preview"]).toBe("call me at 555");
  });

  it("leaves the preview alone when a newer message owns it", async () => {
    const ccf = Object.assign(new Error("ccf"), { name: "ConditionalCheckFailedException" });
    sendMock.mockResolvedValueOnce({ Attributes: { ...row(true), seq: 3 } }).mockRejectedValueOnce(ccf);
    expect(await setHidden("ch-everyone", "01J", true, "u-staff")).toBe(true);
  });

  it("reports a missing message", async () => {
    const ccf = Object.assign(new Error("ccf"), { name: "ConditionalCheckFailedException" });
    sendMock.mockRejectedValueOnce(ccf);
    expect(await setHidden("ch-everyone", "nope", true, "u-staff")).toBe(false);
    expect(sendMock).toHaveBeenCalledTimes(1);
  });
});
