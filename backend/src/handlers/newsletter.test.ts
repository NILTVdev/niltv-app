import { beforeEach, describe, expect, it, vi } from "vitest";

const sendMock = vi.hoisted(() => vi.fn());
const sesSendMock = vi.hoisted(() => vi.fn());

vi.mock("../lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/db")>();
  return {
    ...actual,
    getDocClient: () => ({ send: sendMock }),
  };
});
vi.mock("@aws-sdk/client-sesv2", () => ({
  SESv2Client: class {
    send = sesSendMock;
  },
  SendEmailCommand: class {
    constructor(public readonly input: Record<string, unknown>) {}
  },
}));

import { handler } from "./newsletter";

async function invoke(event: Record<string, unknown>) {
  const result = await handler(event as never, {} as never, () => undefined);
  if (result === undefined || typeof result === "string") {
    throw new Error("expected a structured APIGatewayProxyStructuredResultV2");
  }
  return result;
}

const makeEvent = (body: unknown) => ({
  body: body === undefined ? undefined : JSON.stringify(body),
  requestContext: { http: { method: "POST" } },
});

type Call = { input: Record<string, any> };
const input = (i: number): Record<string, any> => (sendMock.mock.calls[i]?.[0] as Call).input;

describe("POST /v1/newsletter handler (design §6.7 + double opt-in)", () => {
  beforeEach(() => {
    sendMock.mockReset();
    sendMock.mockResolvedValue({});
    sesSendMock.mockReset();
    sesSendMock.mockResolvedValue({});
    process.env.TABLE_NAME = "niltv-test";
    process.env.PUBLIC_API_ORIGIN = "https://api.test";
    process.env.EMAIL_LOGO_BASE = "https://cdn.test";
    delete process.env.ORIGIN_VERIFY_SECRET;
    delete process.env.BEEHIIV_API_KEY;
  });

  it("rejects a malformed body", async () => {
    const res = await invoke(makeEvent({ email: "not-an-email", source: "topbar" }));
    expect(res.statusCode).toBe(400);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("first signup: SUB row unconfirmed + token row + confirm email, email normalized", async () => {
    // Get -> no row, Put SUB, Put NLTOKEN
    sendMock.mockResolvedValueOnce({ Item: undefined });
    const res = await invoke(
      makeEvent({ email: "  Fan@Example.COM ", phone: "+15551234567", source: "post_vote" }),
    );
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body ?? "")).toEqual({ status: "ok" });

    expect(input(0)["Key"]).toEqual({ PK: "SUB#fan@example.com", SK: "META" });
    const put = input(1);
    expect(put["ConditionExpression"]).toBe("attribute_not_exists(PK)");
    expect(put["Item"]).toMatchObject({
      PK: "SUB#fan@example.com",
      SK: "META",
      GSI1PK: "SUBS#ALL",
      email: "fan@example.com",
      phone: "+15551234567",
      sources: ["post_vote"],
      confirmed: false,
    });
    expect(put["Item"].GSI1SK).toMatch(/#fan@example\.com$/);
    const token = put["Item"].confirmToken as string;
    expect(token).toMatch(/^[a-f0-9]{48}$/);
    expect(input(2)["Item"]).toMatchObject({ PK: `NLTOKEN#${token}`, SK: "META", email: "fan@example.com" });

    expect(sesSendMock).toHaveBeenCalledTimes(1);
    const mail = (sesSendMock.mock.calls[0]?.[0] as Call).input;
    expect(mail["Destination"]).toEqual({ ToAddresses: ["fan@example.com"] });
    expect(JSON.stringify(mail["Content"])).toContain(`https://api.test/v1/newsletter/confirm?token=${token}`);
    expect(mail["FromEmailAddress"]).toBe("NILTV <no-reply@niltv.com>");
    // the shared shell: branded mark from the CDN, the link on the gold button, plain-text twin
    const html = mail["Content"].Simple.Body.Html.Data as string;
    expect(html).toContain('src="https://cdn.test/video/brand/email/niltv-email@2x.png"');
    expect(html).toContain(`href="https://api.test/v1/newsletter/confirm?token=${token}"`);
    expect(html).toContain(">Confirm my email<");
    expect(mail["Content"].Simple.Body.Text.Data).toContain(`https://api.test/v1/newsletter/confirm?token=${token}`);
  });

  it("confirmed repeat signup appends the new source, keeps createdAt, sends nothing", async () => {
    sendMock.mockResolvedValueOnce({ Item: { confirmed: true } });

    const res = await invoke(makeEvent({ email: "fan@example.com", source: "recap" }));
    expect(res.statusCode).toBe(200);

    const update = input(1);
    expect(update["Key"]).toEqual({ PK: "SUB#fan@example.com", SK: "META" });
    expect(update["UpdateExpression"]).toContain("list_append");
    expect(update["UpdateExpression"]).not.toContain("createdAt");
    expect(update["ExpressionAttributeValues"][":source"]).toEqual(["recap"]);
    expect(sendMock).toHaveBeenCalledTimes(2);
    expect(sesSendMock).not.toHaveBeenCalled();
  });

  it("unconfirmed repeat resends the standing token only after the throttle window", async () => {
    const stale = new Date(Date.now() - 11 * 60 * 1000).toISOString();
    sendMock.mockResolvedValueOnce({ Item: { confirmed: false, confirmToken: "a".repeat(48), confirmSentAt: stale } });
    await invoke(makeEvent({ email: "fan@example.com", source: "topbar" }));
    expect(sesSendMock).toHaveBeenCalledTimes(1);
    expect(input(2)["UpdateExpression"]).toContain("confirmSentAt");
    expect(input(2)["ExpressionAttributeValues"][":t"]).toBe("a".repeat(48));

    sendMock.mockReset();
    sendMock.mockResolvedValue({});
    sesSendMock.mockReset();
    const fresh = new Date().toISOString();
    sendMock.mockResolvedValueOnce({ Item: { confirmed: false, confirmToken: "a".repeat(48), confirmSentAt: fresh } });
    await invoke(makeEvent({ email: "fan@example.com", source: "topbar" }));
    expect(sesSendMock).not.toHaveBeenCalled();
    expect(sendMock).toHaveBeenCalledTimes(2); // Get + source append only
  });

  it("rethrows non-conditional write failures", async () => {
    sendMock.mockResolvedValueOnce({ Item: undefined });
    sendMock.mockRejectedValueOnce(Object.assign(new Error("throttled"), { name: "Throttling" }));
    await expect(invoke(makeEvent({ email: "fan@example.com", source: "topbar" }))).rejects.toThrow(
      "throttled",
    );
  });
});
