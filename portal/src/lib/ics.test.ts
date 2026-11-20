import { describe, expect, it } from "vitest";
import { buildIcs, foldLine, icsDate, icsEscape, icsFileName } from "./ics";

const now = new Date("2026-10-20T16:00:00.000Z");

describe(".ics generation", () => {
  it("formats UTC stamps", () => {
    expect(icsDate("2026-10-24T01:00:00.000Z")).toBe("20261024T010000Z");
    expect(icsDate(new Date("2026-01-02T03:04:05.678Z"))).toBe("20260102T030405Z");
  });

  it("escapes text values", () => {
    expect(icsEscape("Squads; bring a mic, charger\\cable\nand snacks")).toBe(
      "Squads\\; bring a mic\\, charger\\\\cable\\nand snacks",
    );
  });

  it("builds one event with CRLF lines and a default one-hour end", () => {
    const ics = buildIcs(
      { uid: "ev-1@portal.niltv.com", title: "Thursday night squads", startsAt: "2026-10-24T01:00:00.000Z" },
      now,
    );
    const lines = ics.split("\r\n");
    expect(lines[0]).toBe("BEGIN:VCALENDAR");
    expect(lines).toContain("BEGIN:VEVENT");
    expect(lines).toContain("UID:ev-1@portal.niltv.com");
    expect(lines).toContain("DTSTAMP:20261020T160000Z");
    expect(lines).toContain("DTSTART:20261024T010000Z");
    expect(lines).toContain("DTEND:20261024T020000Z");
    expect(lines).toContain("SUMMARY:Thursday night squads");
    expect(lines.at(-2)).toBe("END:VCALENDAR");
    expect(ics.endsWith("\r\n")).toBe(true);
    expect(ics).not.toMatch(/[^\r]\n/);
  });

  it("carries the end, location, description and stream link", () => {
    const ics = buildIcs(
      {
        uid: "ev-2@portal.niltv.com",
        title: "Live stream",
        startsAt: "2026-10-24T01:00:00.000Z",
        endsAt: "2026-10-24T03:00:00.000Z",
        description: "Two hours, four players.",
        location: "Studio B",
        url: "https://niltv.com/gaming/",
      },
      now,
    );
    expect(ics).toContain("DTEND:20261024T030000Z");
    expect(ics).toContain("LOCATION:Studio B");
    expect(ics).toContain("URL:https://niltv.com/gaming/");
    expect(ics.replace(/\r\n /g, "")).toContain(
      "DESCRIPTION:Two hours\\, four players.\\n\\nStream: https://niltv.com/gaming/",
    );
  });

  it("folds long lines at 75 octets", () => {
    const folded = foldLine(`SUMMARY:${"x".repeat(200)}`);
    const parts = folded.split("\r\n");
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(new TextEncoder().encode(p).length).toBeLessThanOrEqual(75);
    expect(parts.slice(1).every((p) => p.startsWith(" "))).toBe(true);
    expect(folded.replace(/\r\n /g, "")).toBe(`SUMMARY:${"x".repeat(200)}`);
  });

  it("never splits a multi-byte character", () => {
    const line = `SUMMARY:${"é".repeat(80)}`;
    const folded = foldLine(line);
    for (const p of folded.split("\r\n")) expect(new TextEncoder().encode(p).length).toBeLessThanOrEqual(75);
    expect(folded.replace(/\r\n /g, "")).toBe(line);
  });

  it("names the file from the title", () => {
    expect(icsFileName("Thursday night squads!")).toBe("thursday-night-squads.ics");
    expect(icsFileName("***")).toBe("event.ics");
  });
});
