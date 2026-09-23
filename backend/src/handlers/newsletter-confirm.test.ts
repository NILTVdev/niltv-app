import { beforeEach, describe, expect, it, vi } from "vitest";

const sendMock = vi.hoisted(() => vi.fn());

vi.mock("../lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/db")>();
  return { ...actual, getDocClient: () => ({ send: sendMock }) };
});

import { handler } from "./newsletter-confirm";

const TOKEN = "b".repeat(48);
type Call = { input: Record<string, any> };
const input = (i: number): Record<string, any> => (sendMock.mock.calls[i]?.[0] as Call).input;

async function invoke(token: string | undefined) {
  const event = { queryStringParameters: token === undefined ? undefined : { token }, requestContext: { http: { method: "GET" } } };
  const result = await handler(event as never, {} as never, () => undefined);
  if (result === undefined || typeof result === "string") throw new Error("expected structured result");
  return result;
}

describe("GET /v1/newsletter/confirm (double opt-in)", () => {
  beforeEach(() => {
    sendMock.mockReset();
    sendMock.mockResolvedValue({});
    process.env.TABLE_NAME = "niltv-test";
    process.env.SITE_ORIGIN = "https://site.test";
    delete process.env.ORIGIN_VERIFY_SECRET;
    delete process.env.BEEHIIV_API_KEY;
  });

  it("bounces a malformed token to the site without touching the table", async () => {
    const res = await invoke("not-a-token");
    expect(res.statusCode).toBe(302);
    expect(res.headers?.["location"]).toBe("https://site.test/?newsletter=invalid");
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("bounces an unknown token", async () => {
    sendMock.mockResolvedValueOnce({ Item: undefined });
    const res = await invoke(TOKEN);
    expect(res.headers?.["location"]).toContain("newsletter=invalid");
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it("flips the subscriber, retires the token, redirects confirmed", async () => {
    sendMock
      .mockResolvedValueOnce({ Item: { email: "fan@example.com" } })
      .mockResolvedValueOnce({ Attributes: { sources: ["recap"] } });
    const res = await invoke(TOKEN);
    expect(res.statusCode).toBe(302);
    expect(res.headers?.["location"]).toBe("https://site.test/?newsletter=confirmed");
    expect(input(0)["Key"]).toEqual({ PK: `NLTOKEN#${TOKEN}`, SK: "META" });
    const upd = input(1);
    expect(upd["Key"]).toEqual({ PK: "SUB#fan@example.com", SK: "META" });
    expect(upd["UpdateExpression"]).toContain("confirmed = :t");
    expect(upd["UpdateExpression"]).toContain("REMOVE confirmToken");
    expect(input(2)["Key"]).toEqual({ PK: `NLTOKEN#${TOKEN}`, SK: "META" });
  });
});
