import { beforeEach, describe, expect, it, vi } from "vitest";

const sendMock = vi.hoisted(() => vi.fn());
vi.mock("../../lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/db")>();
  return { ...actual, getDocClient: () => ({ send: sendMock }) };
});

import { handler } from "./comment-moderation";

async function invoke(o: { method: string; path: string; id?: string; query?: Record<string, string>; body?: unknown; groups?: unknown }) {
  const result = await handler(
    {
      rawPath: o.path,
      pathParameters: o.id ? { id: o.id } : undefined,
      queryStringParameters: o.query,
      body: o.body === undefined ? undefined : JSON.stringify(o.body),
      isBase64Encoded: false,
      requestContext: {
        http: { method: o.method, path: o.path },
        authorizer: { jwt: { claims: { sub: "staff-1", "cognito:groups": o.groups ?? "[staff]" } } },
      },
    } as never,
    {} as never,
    () => undefined,
  );
  if (result === undefined || typeof result === "string") throw new Error("expected structured result");
  return result;
}
const sent = () => sendMock.mock.calls.map((c) => (c[0] as { input: Record<string, unknown>; constructor: { name: string } }));
const row = { id: "k1", contentId: "c-1", authorId: "u-1", authorName: "A B.", body: "hi", createdAt: "2026-10-01T00:00:00.000Z", status: "pending", reportCount: 0, authorIs18plus: false };

describe("admin comment moderation", () => {
  beforeEach(() => {
    sendMock.mockReset();
    process.env.TABLE_NAME = "niltv-test";
  });

  it("is staff-only: a fan token gets 403 and nothing is read", async () => {
    const list = await invoke({ method: "GET", path: "/admin/comments", query: { queue: "pending" }, groups: "[fans]" });
    expect(list.statusCode).toBe(403);
    const denied = await invoke({ method: "POST", path: "/admin/comments/k1/remove", id: "k1", body: { reason: "x" }, groups: "[fans]" });
    expect(denied.statusCode).toBe(403);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("lists the pending queue with the author's age bracket", async () => {
    sendMock.mockResolvedValueOnce({ Items: [row, { ...row, id: "k2", status: "hidden" }] });
    const r = await invoke({ method: "GET", path: "/admin/comments", query: { queue: "pending" } });
    const body = JSON.parse(r.body as string);
    expect(body.comments.map((c: { id: string }) => c.id)).toEqual(["k1"]);
    expect(body.comments[0].authorIs18plus).toBe(false);
    expect(sent()[0]?.input["IndexName"]).toBe("GSI2");
  });

  it("requires a queue or contentId and rejects a cross-partition cursor", async () => {
    expect((await invoke({ method: "GET", path: "/admin/comments" })).statusCode).toBe(400);
    const cursor = Buffer.from(JSON.stringify({ GSI2PK: "USER#x", GSI2SK: "y" })).toString("base64url");
    expect((await invoke({ method: "GET", path: "/admin/comments", query: { queue: "reported", cursor } })).statusCode).toBe(400);
  });

  it("remove tombstones with who and why, and leaves both indexes", async () => {
    sendMock.mockResolvedValueOnce({ Item: row }).mockResolvedValueOnce({});
    const r = await invoke({ method: "POST", path: "/admin/comments/k1/remove", id: "k1", body: { reason: "harassment" } });
    expect(JSON.parse(r.body as string)).toEqual({ status: "removed" });
    const update = sent()[1]?.input;
    expect(update?.["UpdateExpression"]).toContain("REMOVE GSI1PK, GSI1SK, GSI2PK, GSI2SK");
    expect(update?.["UpdateExpression"]).not.toContain("body =");
    expect(update?.["ExpressionAttributeValues"]).toMatchObject({ ":by": "staff-1", ":reason": "harassment" });
    expect(sent().map((c) => c.constructor.name)).not.toContain("DeleteCommand");
  });

  it("remove requires a reason", async () => {
    sendMock.mockResolvedValueOnce({ Item: row });
    expect((await invoke({ method: "POST", path: "/admin/comments/k1/remove", id: "k1", body: {} })).statusCode).toBe(400);
  });

  it("approve and restore only move from the matching state, and restore resets reports", async () => {
    sendMock.mockResolvedValueOnce({ Item: row }).mockResolvedValueOnce({});
    await invoke({ method: "POST", path: "/admin/comments/k1/approve", id: "k1" });
    expect(sent()[1]?.input["ExpressionAttributeValues"]).toMatchObject({ ":from": "pending", ":visible": "visible" });

    sendMock.mockReset();
    sendMock.mockResolvedValueOnce({ Item: { ...row, status: "hidden" } }).mockResolvedValueOnce({});
    await invoke({ method: "POST", path: "/admin/comments/k1/restore", id: "k1" });
    expect(sent()[1]?.input["ExpressionAttributeValues"]).toMatchObject({ ":from": "hidden", ":zero": 0 });
  });

  it("409s when the comment changed state under the reviewer", async () => {
    sendMock
      .mockResolvedValueOnce({ Item: row })
      .mockRejectedValueOnce(Object.assign(new Error("c"), { name: "ConditionalCheckFailedException" }));
    expect((await invoke({ method: "POST", path: "/admin/comments/k1/approve", id: "k1" })).statusCode).toBe(409);
  });
});
