import { NOTIFY_TOPIC_CADENCES } from "@niltv/types";
import { describe, expect, it } from "vitest";
import { CADENCE_LABELS, notifyTopicsFor, unreadTitle } from "./format";

describe("tab title", () => {
  it("puts the unread count in front", () => {
    expect(unreadTitle("NIL TV Portal", 3)).toBe("(3) NIL TV Portal");
    expect(unreadTitle("Messages | NIL TV Portal", 1)).toBe("(1) Messages | NIL TV Portal");
  });

  it("drops it at zero and caps it like the badge", () => {
    expect(unreadTitle("NIL TV Portal", 0)).toBe("NIL TV Portal");
    expect(unreadTitle("NIL TV Portal", 150)).toBe("(99+) NIL TV Portal");
  });
});

describe("notification topics by role", () => {
  const topics = (role: Parameters<typeof notifyTopicsFor>[0]) => notifyTopicsFor(role).map((t) => t.topic);

  it("gives athletes every topic", () => {
    expect(topics("athlete")).toEqual(["direct", "groups", "announcements", "channels", "schedule", "postings"]);
    expect(notifyTopicsFor("athlete")[0]).toMatchObject({ label: "Messages to you" });
  });

  it("gives guests their messages, groups and schedule", () => {
    expect(topics("guest")).toEqual(["direct", "groups", "schedule"]);
    expect(notifyTopicsFor("guest")[0]!.help).not.toMatch(/posting/i);
  });

  it("words the direct topic for the desks staff answer", () => {
    for (const role of ["staff", "admin"] as const) {
      expect(topics(role)).toEqual(["direct", "groups", "schedule"]);
      expect(notifyTopicsFor(role)[0]).toMatchObject({ label: "Desk messages and @mentions" });
    }
  });

  it("never offers Right away for channels", () => {
    expect(NOTIFY_TOPIC_CADENCES.channels.map((c) => CADENCE_LABELS[c])).toEqual(["Daily summary", "Off"]);
  });
});
