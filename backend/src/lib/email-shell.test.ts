import { describe, expect, it } from "vitest";

import { buttonBlock, codeBlock, credentialsBlock, emailShell } from "./email-shell";

const shell = (body: string, logoBase?: string) =>
  emailShell({
    logoBase,
    title: "Test",
    heading: "HEADING",
    lead: "Lead copy.",
    body,
    tail: "Tail copy.",
  });

describe("email shell", () => {
  it("is a complete document with explicit colours on the ground", () => {
    const html = shell(codeBlock("123456"));
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain('<body style="margin:0;padding:0;background:#0a0a0a;" bgcolor="#0a0a0a">');
    expect(html).toContain("<title>Test</title>");
    expect(html).toContain("HEADING");
    expect(html).toContain("Lead copy.");
    expect(html).toContain("Tail copy.");
    expect(html).toContain('href="https://niltv.com"');
    expect(html.trimEnd().endsWith("</html>")).toBe(true);
  });

  it("swaps the mark for a text wordmark when no CDN base is set", () => {
    expect(shell("", "https://cdn.example")).toContain('src="https://cdn.example/video/brand/email/niltv-email@2x.png"');
    expect(shell("")).not.toContain("<img");
    expect(shell("")).toContain("NIL TV");
  });

  it("blocks render the text they are given", () => {
    expect(codeBlock("{####}")).toContain(">{####}<");
    expect(codeBlock("{####}")).toContain("YOUR CODE");
    const button = buttonBlock("Confirm my email", "https://api.test/confirm?token=abc");
    expect(button).toContain('href="https://api.test/confirm?token=abc"');
    expect(button).toContain(">Confirm my email<");
    const creds = credentialsBlock([
      { label: "USERNAME", value: "{username}" },
      { label: "TEMPORARY PASSWORD", value: "{####}", mono: true },
    ]);
    expect(creds).toContain(">{username}<");
    expect(creds).toContain(">{####}<");
    expect(creds).toContain("monospace");
  });
});
