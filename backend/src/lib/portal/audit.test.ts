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

  it("diffs a new row against nothing and keeps contact details out", () => {
    const entry = auditEntry("admin-1", "member.add", "u-2", {
      after: {
        sub: "u-2",
        email: "athlete@example.com",
        name: "A Person",
        instagram: "handle",
        role: "athlete",
        status: "active",
        stripe: { status: "active" },
      },
    });
    expect(entry.changes).toEqual({
      sub: { after: "u-2" },
      role: { after: "athlete" },
      status: { after: "active" },
      email: "<changed>",
      name: "<changed>",
      instagram: "<changed>",
      stripe: "<changed>",
    });
    expect(JSON.stringify(entry)).not.toMatch(/athlete@example\.com|handle|A Person/);
  });

  it("never logs desk or support addresses", () => {
    const entry = auditEntry("admin-1", "settings.update", "settings", {
      before: { supportEmail: "a@niltv.com", deskEmails: {}, webPush: false },
      after: { supportEmail: "b@niltv.com", deskEmails: { help: ["c@niltv.com"] }, webPush: true },
    });
    expect(entry.changes).toEqual({
      supportEmail: "<changed>",
      deskEmails: "<changed>",
      webPush: { before: false, after: true },
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
