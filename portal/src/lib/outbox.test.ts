import { describe, expect, it } from "vitest";
import {
  type PendingMessage,
  clearOutbox,
  draftFor,
  failedNotice,
  hasFailed,
  isOnScreen,
  markFailed,
  pendingFor,
  removePending,
  saveDraft,
  showThread,
  updatePending,
  upsertPending,
} from "./outbox";

const msg = (clientMsgId: string, state: PendingMessage["state"] = "sending"): PendingMessage => ({
  clientMsgId,
  body: `body ${clientMsgId}`,
  mentions: [],
  important: false,
  at: "2026-11-12T12:00:00.000Z",
  state,
});

describe("pending list steps", () => {
  it("adds, replaces on retry, fails and removes by clientMsgId", () => {
    let list = upsertPending([], msg("a"));
    list = upsertPending(list, msg("b"));
    list = markFailed(list, "a", "Could not reach the portal.");
    expect(list.map((p) => [p.clientMsgId, p.state])).toEqual([
      ["a", "failed"],
      ["b", "sending"],
    ]);
    list = upsertPending(list, msg("a"));
    expect(list.map((p) => p.clientMsgId)).toEqual(["b", "a"]);
    expect(removePending(list, "b").map((p) => p.clientMsgId)).toEqual(["a"]);
  });

  it("marks nothing when the send is no longer listed", () => {
    expect(markFailed([], "gone", "x")).toEqual([]);
  });
});

describe("outbox store", () => {
  it("keeps a thread's sends after it leaves the screen", () => {
    clearOutbox();
    const leave = showThread("c1");
    updatePending("c1", (l) => upsertPending(l, msg("a")));
    expect(isOnScreen("c1")).toBe(true);
    leave();
    expect(isOnScreen("c1")).toBe(false);
    updatePending("c1", (l) => markFailed(l, "a", "Not sent."));
    expect(pendingFor("c1")[0]?.state).toBe("failed");
    expect(hasFailed("c1")).toBe(true);
    expect(hasFailed("c2")).toBe(false);
  });

  it("counts the same thread open twice until both leave", () => {
    const a = showThread("c3");
    const b = showThread("c3");
    a();
    expect(isOnScreen("c3")).toBe(true);
    b();
    expect(isOnScreen("c3")).toBe(false);
  });

  it("keeps drafts with text and drops empty ones", () => {
    clearOutbox();
    saveDraft("c1", { text: "half a thought", picked: [], important: false });
    expect(draftFor("c1")?.text).toBe("half a thought");
    saveDraft("c1", { text: "   ", picked: [], important: false });
    expect(draftFor("c1")).toBeUndefined();
  });

  it("forgets everything on sign-out", () => {
    updatePending("c1", (l) => upsertPending(l, msg("a")));
    saveDraft("c1", { text: "x", picked: [], important: false });
    clearOutbox();
    expect(pendingFor("c1")).toEqual([]);
    expect(draftFor("c1")).toBeUndefined();
  });
});

describe("failedNotice", () => {
  it("names the thread", () => {
    expect(failedNotice("Payments")).toBe("A message to Payments was not sent. Open it to retry.");
    expect(failedNotice(undefined)).toBe("A message was not sent. Open the thread to retry.");
  });
});
