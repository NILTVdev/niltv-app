import { NotifyPrefs, type PortalMember } from "@niltv/types";
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2, Context } from "aws-lambda";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ send: vi.fn(), authorize: vi.fn() }));

vi.mock("../db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../db")>()),
  getDocClient: () => ({ send: m.send }),
}));
vi.mock("./access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./access")>()),
  authorize: m.authorize,
}));

import { RATE_LIMITED_MESSAGE, ROUTE_LIMITS, rateLimitedMessage, secondsLeft, takeWrite } from "./limits";
import { ok, portalHandler } from "./router";

const ccf = Object.assign(new Error("conditional"), { name: "ConditionalCheckFailedException" });

const member: PortalMember = {
  sub: "u-1",
  email: "a@example.com",
  name: "Jordan M.",
  role: "athlete",
  status: "active",
  desks: [],
  edited: [],
  notify: NotifyPrefs.parse({}),
  createdAt: "2026-10-01T00:00:00.000Z",
};

beforeEach(() => {
  m.send.mockReset();
  m.authorize.mockReset();
  m.authorize.mockResolvedValue({ caller: { sub: "u-1", member } });
  process.env.TABLE_NAME = "niltv-test";
});

describe("takeWrite", () => {
  const limit = { bucket: "help", max: 5, windowMs: 3_600_000 };
  const now = Date.parse("2026-11-12T15:30:00.000Z");

  it("counts in the caller's own partition", async () => {
    m.send.mockResolvedValueOnce({});
    expect(await takeWrite("u-1", limit, now)).toBe(true);
    const input = m.send.mock.calls[0]![0].input;
    expect(input.Key).toEqual({ PK: "USER#u-1", SK: "LIMIT#help" });
    expect(input.ConditionExpression).toBe("win = :win AND n < :max");
    expect(input.ExpressionAttributeValues).toEqual({ ":one": 1, ":win": Math.floor(now / 3_600_000), ":max": 5 });
  });

  it("starts a fresh window when the stored one is old", async () => {
    m.send.mockRejectedValueOnce(ccf).mockResolvedValueOnce({});
    expect(await takeWrite("u-1", limit, now)).toBe(true);
    expect(m.send.mock.calls[1]![0].input.UpdateExpression).toBe("SET win = :win, n = :one");
  });

  it("refuses once the window's allowance is spent", async () => {
    m.send.mockRejectedValueOnce(ccf).mockRejectedValueOnce(ccf).mockRejectedValueOnce(ccf);
    expect(await takeWrite("u-1", limit, now)).toBe(false);
    expect(m.send).toHaveBeenCalledTimes(3);
  });

  it("counts the loser of a race to open the window", async () => {
    // Both callers miss the old window; the other one wins the reset.
    m.send.mockRejectedValueOnce(ccf).mockRejectedValueOnce(ccf).mockResolvedValueOnce({});
    expect(await takeWrite("u-1", limit, now)).toBe(true);
    expect(m.send.mock.calls[2]![0].input.UpdateExpression).toBe("ADD n :one");
  });

  it("tells the member how long to wait", () => {
    expect(secondsLeft({ bucket: "m", max: 1, windowMs: 60_000 }, Date.parse("2026-11-12T15:30:45.500Z"))).toBe(15);
    expect(rateLimitedMessage(ROUTE_LIMITS["POST /v1/conversations/{id}/messages"]!)).toBe(RATE_LIMITED_MESSAGE);
    expect(rateLimitedMessage(ROUTE_LIMITS["POST /v1/requests"]!)).toContain("tomorrow");
  });

  it("sets the caps the launch list asks for", () => {
    expect(ROUTE_LIMITS["POST /v1/conversations/{id}/messages"]).toMatchObject({ max: 30, windowMs: 60_000 });
    expect(ROUTE_LIMITS["POST /v1/help"]).toMatchObject({ max: 5, windowMs: 3_600_000 });
    expect(ROUTE_LIMITS["POST /v1/requests"]).toMatchObject({ max: 5, windowMs: 86_400_000 });
    expect(ROUTE_LIMITS["POST /v1/asks/{id}/uploads"]).toMatchObject({ max: 30, windowMs: 60_000 });
    expect(ROUTE_LIMITS["POST /v1/postings/{id}/action"]?.windowMs).toBe(60_000);
    expect(ROUTE_LIMITS["POST /v1/asks/{id}/action"]?.windowMs).toBe(60_000);
    expect(ROUTE_LIMITS["GET /v1/inbox"]).toBeUndefined();
  });
});

describe("portalHandler write limits", () => {
  const route = vi.fn(async () => ok({ status: "ok" }));
  const handler = portalHandler({ "POST /v1/help": route, "GET /v1/inbox": route });
  const call = (routeKey: string) =>
    handler({ routeKey, body: "{}" } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer, {} as Context, () => {}) as Promise<APIGatewayProxyStructuredResultV2>;

  beforeEach(() => route.mockClear());

  it("answers 429 with the portal error and skips the route when the limit is spent", async () => {
    m.send.mockRejectedValue(ccf);
    const res = await call("POST /v1/help");
    expect(res.statusCode).toBe(429);
    const body = JSON.parse(String(res.body));
    expect(body).toMatchObject({ error: "RATE_LIMITED", message: "That is the most for one hour. Try again later." });
    expect(body.retryAfterSec).toBeGreaterThan(0);
    expect(body.retryAfterSec).toBeLessThanOrEqual(3600);
    expect(route).not.toHaveBeenCalled();
  });

  it("runs the route while there is allowance left", async () => {
    m.send.mockResolvedValue({});
    expect((await call("POST /v1/help")).statusCode).toBe(200);
    expect(route).toHaveBeenCalledTimes(1);
  });

  it("does not count reads", async () => {
    expect((await call("GET /v1/inbox")).statusCode).toBe(200);
    expect(m.send).not.toHaveBeenCalled();
  });

  it("lets the write through when the counter cannot be reached", async () => {
    m.send.mockRejectedValue(new Error("throttled"));
    expect((await call("POST /v1/help")).statusCode).toBe(200);
  });
});
