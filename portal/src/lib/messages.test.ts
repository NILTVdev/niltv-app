import type { PortalMessage } from "@niltv/types";
import { describe, expect, it } from "vitest";
import { lastId, mergeMessages, newClientMsgId, newestSeq } from "./messages";

const msg = (seq: number, over: Partial<PortalMessage> = {}): PortalMessage => ({
  id: `m${String(seq).padStart(3, "0")}`,
  convId: "c1",
  seq,
  authorName: "Member",
  authorRole: "athlete",
  mine: false,
  body: `message ${seq}`,
  at: "2026-10-20T16:00:00.000Z",
  hidden: false,
  ...over,
});

describe("thread message merging", () => {
  it("appends a delta poll in seq order without duplicates", () => {
    const merged = mergeMessages([msg(1), msg(2)], [msg(2), msg(3)]);
    expect(merged.map((m) => m.seq)).toEqual([1, 2, 3]);
  });

  it("prepends an older page", () => {
    expect(mergeMessages([msg(5), msg(6)], [msg(3), msg(4)]).map((m) => m.seq)).toEqual([3, 4, 5, 6]);
  });

  it("lets a refreshed copy replace the old one (hide and unhide)", () => {
    const merged = mergeMessages([msg(1), msg(2)], [msg(2, { hidden: true, body: "" })]);
    expect(merged[1]).toMatchObject({ seq: 2, hidden: true, body: "" });
  });

  it("returns the same list when nothing came in", () => {
    const list = [msg(1)];
    expect(mergeMessages(list, [])).toBe(list);
  });

  it("finds the newest seq and the id for ?after=", () => {
    const list = [msg(4), msg(9), msg(7)];
    expect(newestSeq(list)).toBe(9);
    expect(lastId(list)).toBe("m009");
    expect(newestSeq([])).toBe(0);
    expect(lastId([])).toBeUndefined();
  });

  it("makes client ids the API accepts (8 to 64 chars)", () => {
    const id = newClientMsgId();
    expect(id.length).toBeGreaterThanOrEqual(8);
    expect(id.length).toBeLessThanOrEqual(64);
    expect(newClientMsgId()).not.toBe(id);
  });
});
