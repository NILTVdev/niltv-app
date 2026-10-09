import { beforeEach, describe, expect, it, vi } from "vitest";

const sendMock = vi.hoisted(() => vi.fn());
vi.mock("../lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/db")>();
  return { ...actual, getDocClient: () => ({ send: sendMock }) };
});

import { handler } from "./blocks";

async function invoke(method: string, userId?: string, sub: string | null = "u-1") {
  const result = await handler(
    {
      pathParameters: userId ? { userId } : undefined,
      requestContext: { http: { method }, authorizer: { jwt: { claims: sub === null ? {} : { sub } } } },
    } as never,
    {} as never,
    () => undefined,
  );
  if (result === undefined || typeof result === "string") throw new Error("expected structured result");
  return result;
}
const sent = () => sendMock.mock.calls.map((c) => (c[0] as { input: Record<string, unknown>; constructor: { name: string } }));

describe("blocks handler", () => {
  beforeEach(() => {
    sendMock.mockReset();
    process.env.TABLE_NAME = "niltv-test";
  });

  it("401s without a sub", async () => {
    expect((await invoke("GET", undefined, null)).statusCode).toBe(401);
  });

  it("lists the caller's blocks only, from their own partition", async () => {
    sendMock.mockResolvedValueOnce({ Items: [{ PK: "USER#u-1", SK: "BLOCK#u-2", name: "Sam K." }] });
    const r = await invoke("GET");
    expect(JSON.parse(r.body as string)).toEqual({ blocks: [{ userId: "u-2", name: "Sam K." }] });
    expect((sent()[0]?.input["ExpressionAttributeValues"] as Record<string, unknown>)[":pk"]).toBe("USER#u-1");
  });

  it("blocks with the name read from the target row, not the client", async () => {
    sendMock.mockResolvedValueOnce({ Item: { name: "Sam Karlsson" } }).mockResolvedValueOnce({});
    expect((await invoke("PUT", "u-2")).statusCode).toBe(200);
    const put = sent()[1]?.input["Item"] as Record<string, unknown>;
    expect(put).toMatchObject({ PK: "USER#u-1", SK: "BLOCK#u-2", name: "Sam K." });
  });

  it("refuses self-blocks and unknown users", async () => {
    expect((await invoke("PUT", "u-1")).statusCode).toBe(400);
    sendMock.mockResolvedValueOnce({ Item: undefined });
    expect((await invoke("PUT", "ghost")).statusCode).toBe(404);
  });

  it("unblock is a plain idempotent delete of the caller's own row", async () => {
    sendMock.mockResolvedValueOnce({});
    expect((await invoke("DELETE", "u-2")).statusCode).toBe(200);
    expect(sent()[0]?.input["Key"]).toEqual({ PK: "USER#u-1", SK: "BLOCK#u-2" });
  });
});
