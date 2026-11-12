import { PortalMember } from "@niltv/types";
import { describe, expect, it } from "vitest";
import { audienceIncludes } from "../../lib/portal/audience";
import { escapeHtml, formatWhen, renderEmail } from "../../lib/portal/emails";
import { canAdd, canEdit } from "./members";
import { mergeRoster, rosterFields } from "./roster-sync";
import { buildOptions, optionId } from "./schedule";

const member = (over: Partial<PortalMember> = {}): PortalMember =>
  PortalMember.parse({
    sub: "u-1",
    email: "a@example.com",
    name: "Jordan M.",
    role: "athlete",
    status: "active",
    createdAt: "2026-10-01T00:00:00.000Z",
    ...over,
  });

const caller = (role: PortalMember["role"], sub = "u-caller") => ({ sub, member: member({ sub, role }) });

describe("who may edit a member", () => {
  it("lets admins change anything except their own role and status", () => {
    expect(canEdit(caller("admin"), member({ role: "staff" }), { role: "admin" })).toBe(true);
    const self = member({ sub: "u-caller", role: "admin" });
    expect(canEdit(caller("admin"), self, { role: "staff" })).toBe(false);
    expect(canEdit(caller("admin"), self, { status: "disabled" })).toBe(false);
    expect(canEdit(caller("admin"), self, { name: "New Name" })).toBe(true);
  });

  it("lets staff manage guests and athlete roster fields only", () => {
    expect(canEdit(caller("staff"), member({ role: "guest" }), { status: "disabled" })).toBe(true);
    expect(canEdit(caller("staff"), member(), { sport: "Football" })).toBe(true);
    expect(canEdit(caller("staff"), member(), { status: "active" })).toBe(false);
    expect(canEdit(caller("staff"), member(), { role: "guest" })).toBe(false);
    expect(canEdit(caller("staff"), member({ role: "staff" }), { name: "X" })).toBe(false);
    expect(canEdit(caller("staff"), member({ role: "admin" }), { name: "X" })).toBe(false);
  });

  it("refuses athletes and guests", () => {
    expect(canEdit(caller("athlete"), member({ role: "guest" }), { name: "X" })).toBe(false);
    expect(canEdit(caller("guest"), member(), { name: "X" })).toBe(false);
  });
});

describe("who may add a member", () => {
  it("lets staff add guests and admins add any role", () => {
    expect(canAdd(caller("staff"), "guest")).toBe(true);
    expect(canAdd(caller("staff"), "athlete")).toBe(false);
    expect(canAdd(caller("admin"), "staff")).toBe(true);
    expect(canAdd(caller("athlete"), "guest")).toBe(false);
  });

  it("stops staff bringing back a disabled or waiting account as a guest", () => {
    expect(canAdd(caller("staff"), "guest", member({ status: "disabled" }))).toBe(false);
    expect(canAdd(caller("staff"), "guest", member({ status: "ready" }))).toBe(false);
    expect(canAdd(caller("staff"), "guest", member({ role: "staff", status: "disabled" }))).toBe(false);
    expect(canAdd(caller("admin"), "guest", member({ status: "disabled" }))).toBe(true);
  });

  it("lets staff re-add a former guest as a guest", () => {
    expect(canAdd(caller("staff"), "guest", member({ role: "guest", status: "disabled" }))).toBe(true);
  });
});

describe("schedule options", () => {
  it("sorts, dedupes and ids options by start time", () => {
    const out = buildOptions([
      { startsAt: "2026-10-23T00:00:00.000Z" },
      { startsAt: "2026-10-21T00:00:00.000Z", endsAt: "2026-10-21T02:00:00.000Z" },
      { startsAt: "2026-10-23T00:00:00.000Z" },
    ]);
    expect(out?.map((o) => o.startsAt)).toEqual(["2026-10-21T00:00:00.000Z", "2026-10-23T00:00:00.000Z"]);
    expect(out?.[0]?.id).toBe(optionId("2026-10-21T00:00:00.000Z"));
  });

  it("rejects an end before its start", () => {
    expect(buildOptions([{ startsAt: "2026-10-21T02:00:00.000Z", endsAt: "2026-10-21T01:00:00.000Z" }])).toBeUndefined();
  });

  it("invites by campus, sport, group and person", () => {
    const athlete = member({ campus: "truebluetv", sport: "Women's Basketball" });
    const none = new Set<string>();
    expect(audienceIncludes({ type: "everyone" }, athlete, none)).toBe(true);
    expect(audienceIncludes({ type: "everyone" }, member({ role: "guest" }), none)).toBe(false);
    expect(audienceIncludes({ type: "campus", campus: "truebluetv" }, athlete, none)).toBe(true);
    expect(audienceIncludes({ type: "sport", sport: "Men's Basketball" }, athlete, none)).toBe(false);
    expect(audienceIncludes({ type: "group", convId: "grp-1" }, member({ role: "guest" }), new Set(["grp-1"]))).toBe(true);
    expect(audienceIncludes({ type: "people", subs: ["u-1"] }, athlete, none)).toBe(true);
    expect(audienceIncludes({ type: "people", subs: ["u-2"] }, member({ role: "staff" }), none)).toBe(true);
  });
});

describe("roster sync", () => {
  const app = {
    id: 42,
    email: "jordan@example.com",
    first_name: "Jordan",
    last_name: "Miles",
    university: "Duke University",
    sport: "Women's Basketball",
    year: "Junior",
    campus_channel: "truebluetv",
    instagram: "@JordanM",
    international: false,
    status: "accepted",
  };

  it("maps an accepted application to roster fields", () => {
    expect(rosterFields(app)).toEqual({
      name: "Jordan Miles",
      campus: "truebluetv",
      school: "Duke University",
      sport: "Women's Basketball",
      year: "Junior",
      instagram: "jordanm",
      applicationId: 42,
      stripe: "complete",
    });
    expect(rosterFields({ ...app, campus_channel: "other", international: true })).toMatchObject({ stripe: "international" });
    expect(rosterFields({ ...app, campus_channel: "other" }).campus).toBeUndefined();
  });

  it("never overwrites a field staff edited by hand", () => {
    const edited = member({ sport: "Football", edited: ["sport"] });
    const merged = mergeRoster(edited, rosterFields(app));
    expect(merged.sport).toBe("Football");
    expect(merged.campus).toBe("truebluetv");
  });
});

describe("email", () => {
  it("escapes everything dynamic", () => {
    expect(escapeHtml(`<script>"x"&'y'</script>`)).toBe("&lt;script&gt;&quot;x&quot;&amp;&#39;y&#39;&lt;/script&gt;");
    const { html, text } = renderEmail({
      subject: "Hi <b>",
      heading: "New posting",
      lead: "A <i>posting</i>",
      paragraphs: ["Line one\nLine two"],
      button: { label: "See it", path: "/postings/p-1" },
    });
    expect(html).not.toContain("<i>posting</i>");
    expect(html).toContain("A &lt;i&gt;posting&lt;/i&gt;");
    expect(text).toContain("/postings/p-1");
  });

  it("formats times in the reader's zone, Eastern by default", () => {
    expect(formatWhen("2026-10-24T00:00:00.000Z", undefined)).toMatch(/Oct 23.*8:00\sPM EDT/);
    expect(formatWhen("2026-10-24T00:00:00.000Z", "America/Los_Angeles")).toMatch(/5:00\sPM PDT/);
    expect(formatWhen("2026-10-24T00:00:00.000Z", "Not/AZone")).toMatch(/EDT/);
  });
});
