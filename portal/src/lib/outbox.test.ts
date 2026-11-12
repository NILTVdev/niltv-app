import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type PendingMessage,
  clearOutbox,
  discardPending,
  forgetResend,
  holdForResend,
  isHeld,
  outboxEpoch,
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
  it("moves to a new epoch on sign-out, so late sends stay quiet", () => {
    const before = outboxEpoch();
    clearOutbox();
    expect(outboxEpoch()).not.toBe(before);
  });

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

describe("held resends", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clearOutbox();
  });
  afterEach(() => {
    clearOutbox();
    vi.useRealTimers();
  });

  const hold = (resend: () => void, epoch = outboxEpoch(), max = 3) =>
    holdForResend("c1", "a", { waitMs: 1000, epoch, max, resend });

  it("resends once after the wait, with no thread on screen", () => {
    updatePending("c1", (l) => upsertPending(l, msg("a")));
    const resend = vi.fn();
    expect(hold(resend)).toBe("held");
    expect(isHeld("c1", "a")).toBe(true);
    vi.advanceTimersByTime(999);
    expect(resend).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(resend).toHaveBeenCalledTimes(1);
    expect(isHeld("c1", "a")).toBe(false);
    vi.advanceTimersByTime(10_000);
    expect(resend).toHaveBeenCalledTimes(1);
  });

  it("never resends after discard", () => {
    updatePending("c1", (l) => upsertPending(l, msg("a")));
    const resend = vi.fn();
    hold(resend);
    discardPending("c1", "a");
    vi.advanceTimersByTime(5000);
    expect(resend).not.toHaveBeenCalled();
    expect(pendingFor("c1")).toEqual([]);
  });

  it("drops the resend when the message left the outbox another way", () => {
    updatePending("c1", (l) => upsertPending(l, msg("a")));
    const resend = vi.fn();
    hold(resend);
    updatePending("c1", (l) => removePending(l, "a"));
    vi.advanceTimersByTime(5000);
    expect(resend).not.toHaveBeenCalled();
  });

  it("never resends after sign-out", () => {
    updatePending("c1", (l) => upsertPending(l, msg("a")));
    const resend = vi.fn();
    hold(resend);
    clearOutbox();
    // The next member queues a message with the same id; it is still not theirs to resend.
    updatePending("c1", (l) => upsertPending(l, msg("a")));
    vi.advanceTimersByTime(5000);
    expect(resend).not.toHaveBeenCalled();
  });

  it("refuses to hold a send from an earlier epoch", () => {
    const old = outboxEpoch();
    clearOutbox();
    updatePending("c1", (l) => upsertPending(l, msg("a")));
    const resend = vi.fn();
    expect(hold(resend, old)).toBe("gone");
    vi.advanceTimersByTime(5000);
    expect(resend).not.toHaveBeenCalled();
  });

  it("refuses to hold a message already discarded", () => {
    expect(hold(vi.fn())).toBe("gone");
  });

  it("is spent after max holds of the same message", () => {
    updatePending("c1", (l) => upsertPending(l, msg("a")));
    const resend = vi.fn();
    for (let i = 0; i < 3; i++) {
      expect(hold(resend)).toBe("held");
      vi.advanceTimersByTime(1000);
    }
    expect(resend).toHaveBeenCalledTimes(3);
    expect(hold(resend)).toBe("spent");
    expect(isHeld("c1", "a")).toBe(false);
  });

  it("starts the count over after forgetResend", () => {
    updatePending("c1", (l) => upsertPending(l, msg("a")));
    const resend = vi.fn();
    hold(resend, undefined, 1);
    forgetResend("c1", "a");
    vi.advanceTimersByTime(5000);
    expect(resend).not.toHaveBeenCalled();
    expect(hold(resend, undefined, 1)).toBe("held");
  });

  it("keeps the same id in another thread separate", () => {
    updatePending("c1", (l) => upsertPending(l, msg("a")));
    updatePending("c2", (l) => upsertPending(l, msg("a")));
    const r1 = vi.fn();
    const r2 = vi.fn();
    hold(r1);
    holdForResend("c2", "a", { waitMs: 1000, epoch: outboxEpoch(), max: 3, resend: r2 });
    discardPending("c1", "a");
    vi.advanceTimersByTime(1000);
    expect(r1).not.toHaveBeenCalled();
    expect(r2).toHaveBeenCalledTimes(1);
  });
});
