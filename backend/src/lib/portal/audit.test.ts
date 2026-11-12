import { afterEach, describe, expect, it, vi } from "vitest";
import { audit, auditEntry } from "./audit";

describe("audit", () => {
  afterEach(() => vi.restoreAllMocks());

  it("keeps only the fields that changed", () => {
    const entry = auditEntry("admin-1", "member.update", "u-1", {
      before: { sub: "u-1", role: "athlete", status: "active", updatedAt: "a" },
      after: { sub: "u-1", role: "staff", status: "active", updatedAt: "b" },
    });
    expect(entry).toEqual({
      audit: "portal",
      actor: "admin-1",
      action: "member.update",
      target: "u-1",
      changes: { role: { before: "athlete", after: "staff" } },
    });
  });

  it("logs a plain value when there is no row to compare", () => {
    expect(auditEntry("staff-1", "message.hide", "conv/msg", { after: true })).toEqual({
      audit: "portal",
      actor: "staff-1",
      action: "message.hide",
      target: "conv/msg",
      after: true,
    });
  });

  it("writes one JSON line", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    audit("admin-1", "settings.update", "settings", { before: { a: 1 }, after: { a: 2 } });
    expect(log).toHaveBeenCalledTimes(1);
    const line = JSON.parse(log.mock.calls[0]?.[0] as string);
    expect(line).toMatchObject({ audit: "portal", actor: "admin-1", changes: { a: { before: 1, after: 2 } } });
    expect(typeof line.at).toBe("string");
  });
});
