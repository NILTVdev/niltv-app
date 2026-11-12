import { NotifyPrefs, type PortalMember } from "@niltv/types";
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2, Context } from "aws-lambda";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ send: vi.fn(), authorize: vi.fn(), enqueueOrThrow: vi.fn(), enqueue: vi.fn() }));

vi.mock("../../lib/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/db")>()),
  getDocClient: () => ({ send: m.send }),
}));
vi.mock("../../lib/portal/access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/portal/access")>()),
  authorize: m.authorize,
}));
vi.mock("../../lib/portal/notify", () => ({ enqueue: m.enqueue, enqueueOrThrow: m.enqueueOrThrow }));

import { handler } from "./requests";

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

const help = () =>
  handler(
    { routeKey: "POST /v1/help", body: JSON.stringify({ topic: "account", message: "I cannot see Payments." }) } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer,
    {} as Context,
    () => {},
  ) as Promise<APIGatewayProxyStructuredResultV2>;

beforeEach(() => {
  for (const fn of Object.values(m)) fn.mockReset();
  m.authorize.mockResolvedValue({ caller: { sub: "u-1", member } });
  m.send.mockResolvedValue({});
});

describe("POST /v1/help", () => {
  it("queues the message and answers 202", async () => {
    m.enqueueOrThrow.mockResolvedValue(undefined);
    expect((await help()).statusCode).toBe(202);
    expect(m.enqueueOrThrow).toHaveBeenCalledWith({ type: "help", sub: "u-1", topic: "account", message: "I cannot see Payments." });
  });

  it("tells the member when the message could not be queued, since that is the only copy", async () => {
    m.enqueueOrThrow.mockRejectedValue(new Error("sqs down"));
    const res = await help();
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(String(res.body)).message).toMatch(/did not send/);
  });
});
