import { describe, expect, it } from "vitest";
import { isSafeWebhookUrl, webhookUrlProblem } from "./webhook-url";

describe("webhook URL policy", () => {
  it("accepts an ordinary https endpoint", () => {
    expect(isSafeWebhookUrl("https://hooks.partner.example.com/niltv?token=abc")).toBe(true);
  });

  it("refuses plain http and credentials in the URL", () => {
    expect(webhookUrlProblem("http://hooks.partner.example.com/x")).toBe("must use https");
    expect(webhookUrlProblem("https://user:pw@hooks.partner.example.com/x")).toBe("must not carry credentials");
  });

  it("refuses loopback, metadata, internal names and IP literals", () => {
    expect(webhookUrlProblem("https://localhost/x")).toBe("host is not allowed");
    expect(webhookUrlProblem("https://metadata.google.internal/x")).toBe("host is not allowed");
    expect(webhookUrlProblem("https://api.internal/x")).toBe("host is not allowed");
    expect(webhookUrlProblem("https://169.254.169.254/latest/meta-data")).toBe("IP literals are not allowed");
    expect(webhookUrlProblem("https://10.0.0.5/x")).toBe("IP literals are not allowed");
    expect(webhookUrlProblem("https://[::1]/x")).toBe("IP literals are not allowed");
    expect(webhookUrlProblem("https://intranet/x")).toBe("host must be a fully qualified name");
  });

  it("refuses garbage", () => {
    expect(webhookUrlProblem("not a url")).toBe("not a valid URL");
  });
});
