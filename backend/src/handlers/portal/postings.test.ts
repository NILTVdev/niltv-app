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

import { handler } from "./postings";

const athlete: PortalMember = {
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

const posting = {
  id: "post-1",
  title: "Game day shoot",
  requiresApproval: true,
  status: "open",
  createdBySub: "s-1",
  createdByName: "Staff Member",
  createdAt: "2026-11-01T00:00:00.000Z",
};

const interest = () =>
  handler(
    {
      routeKey: "POST /v1/postings/{id}/action",
      pathParameters: { id: "post-1" },
      body: JSON.stringify({ action: "interest", interested: true }),
    } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer,
    {} as Context,
    () => {},
  ) as Promise<APIGatewayProxyStructuredResultV2>;

const commands = () => m.send.mock.calls.map(([cmd]) => ({ name: cmd.constructor.name as string, input: cmd.input }));

beforeEach(() => {
  for (const fn of Object.values(m)) fn.mockReset();
  m.authorize.mockResolvedValue({ caller: { sub: "u-1", member: athlete } });
  m.send.mockImplementation(async (cmd: { constructor: { name: string } }) =>
    cmd.constructor.name === "GetCommand" ? { Item: posting } : {},
  );
  process.env.TABLE_NAME = "niltv-test";
});

describe("posting interest notice", () => {
  it("queues one staff email and keeps the marker", async () => {
    m.enqueueOrThrow.mockResolvedValue(undefined);
    expect((await interest()).statusCode).toBe(200);
    expect(m.enqueueOrThrow).toHaveBeenCalledWith({ type: "posting.interest", postingId: "post-1", personSub: "u-1" });
    expect(commands().some((c) => c.name === "DeleteCommand")).toBe(false);
  });

  it("clears the marker when the email cannot be queued, so the next interest tries again", async () => {
    m.enqueueOrThrow.mockRejectedValue(new Error("sqs down"));
    expect((await interest()).statusCode).toBe(200);
    const deletes = commands().filter((c) => c.name === "DeleteCommand");
    expect(deletes).toHaveLength(1);
    expect(deletes[0]!.input.Key).toEqual({ PK: "POSTING#post-1", SK: "NOTIFIED#u-1" });
  });
});
