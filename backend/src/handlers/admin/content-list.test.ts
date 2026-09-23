import { beforeEach, describe, expect, it, vi } from "vitest";

const sendMock = vi.hoisted(() => vi.fn());

vi.mock("../../lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/db")>();
  return {
    ...actual,
    getDocClient: () => ({ send: sendMock }),
  };
});

import { contentTombstone } from "../../lib/db";
import { decodeCursor, encodeCursor, handler } from "./content-list";

async function invoke(event: Record<string, unknown>) {
  const result = await handler(event as never, {} as never, () => undefined);
  if (result === undefined || typeof result === "string") {
    throw new Error("expected a structured APIGatewayProxyStructuredResultV2");
  }
  return result;
}

function listEvent(opts: { cursor?: string; staff?: boolean } = {}) {
  const { cursor, staff = true } = opts;
  return {
    ...(cursor === undefined ? {} : { queryStringParameters: { cursor } }),
    requestContext: {
      http: { method: "GET", path: "/admin/content" },
      authorizer: { jwt: { claims: staff ? { "cognito:groups": ["staff"] } : {} } },
    },
  };
}

const contentItem = (id: string) => ({
  PK: `CONTENT#${id}`,
  SK: "META",
  id,
  title: `Clip ${id}`,
  channelId: "ch-niltv",
  athleteId: "ath-camila",
  transcodeStatus: "uploading",
});

describe("GET /admin/content — paginated scan", () => {
  beforeEach(() => {
    sendMock.mockReset();
    process.env.TABLE_NAME = "niltv-test";
  });

  it("scans CONTENT#/META rows with limit 50 and returns full entities", async () => {
    sendMock.mockResolvedValueOnce({ Items: [contentItem("c-1"), contentItem("c-2")] });

    const res = await invoke(listEvent());

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body ?? "");
    expect(body.items).toHaveLength(2);
    // Full admin entity incl. pipeline fields, key attrs stripped.
    expect(body.items[0]).toMatchObject({
      id: "c-1",
      transcodeStatus: "uploading",
      rightsConfirmed: false,
      provider: "hls",
    });
    expect(body.items[0].PK).toBeUndefined();
    expect(body.cursor).toBeUndefined();

    const scan = (sendMock.mock.calls[0]?.[0] as { input: Record<string, any> }).input;
    expect(scan["FilterExpression"]).toBe(
      "begins_with(PK, :pk) AND SK = :sk AND attribute_not_exists(#removed)",
    );
    expect(scan["ExpressionAttributeNames"]).toEqual({ "#removed": "removed" });
    expect(scan["ExpressionAttributeValues"]).toEqual({ ":pk": "CONTENT#", ":sk": "META" });
    expect(scan["Limit"]).toBe(50);
    expect(scan["ExclusiveStartKey"]).toBeUndefined();
  });

  it("skips a tombstone-shaped row instead of throwing, and names it", async () => {
    // The Scan filter keeps tombstones out in production; this pins the
    // second guard so a malformed row can never 500 the whole library.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    sendMock.mockResolvedValueOnce({
      Items: [contentItem("c-1"), contentTombstone("ig-1", "removed by staff"), contentItem("c-2")],
    });

    const res = await invoke(listEvent());

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body ?? "");
    expect(body.items.map((item: { id: string }) => item.id)).toEqual(["c-1", "c-2"]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("CONTENT#ig-1");
    warn.mockRestore();
  });

  it("returns a base64 cursor when the scan has more pages", async () => {
    const lastKey = { PK: "CONTENT#c-2", SK: "META" };
    sendMock.mockResolvedValueOnce({ Items: [contentItem("c-2")], LastEvaluatedKey: lastKey });

    const res = await invoke(listEvent());
    const body = JSON.parse(res.body ?? "");

    expect(typeof body.cursor).toBe("string");
    expect(decodeCursor(body.cursor)).toEqual(lastKey);
  });

  it("resumes from a supplied cursor via ExclusiveStartKey", async () => {
    sendMock.mockResolvedValueOnce({ Items: [] });
    const cursor = encodeCursor({ PK: "CONTENT#c-2", SK: "META" });

    const res = await invoke(listEvent({ cursor }));

    expect(res.statusCode).toBe(200);
    const scan = (sendMock.mock.calls[0]?.[0] as { input: Record<string, any> }).input;
    expect(scan["ExclusiveStartKey"]).toEqual({ PK: "CONTENT#c-2", SK: "META" });
  });

  it("400 on a cursor that is not an encoded table key", async () => {
    for (const bad of [
      "not-base64!!!",
      Buffer.from("\"just a string\"").toString("base64url"),
      Buffer.from(JSON.stringify({ PK: "CONTENT#c-1" })).toString("base64url"), // missing SK
      Buffer.from(JSON.stringify({ PK: "x", SK: "y", Extra: "z" })).toString("base64url"), // smuggled attr
    ]) {
      const res = await invoke(listEvent({ cursor: bad }));
      expect(res.statusCode).toBe(400);
    }
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("cursor round-trips and is URL-safe", () => {
    const key = { PK: "CONTENT#c-weird+/=chars", SK: "META" };
    const cursor = encodeCursor(key);
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/); // base64url alphabet only
    expect(decodeCursor(cursor)).toEqual(key);
  });

  it("403 without the staff group", async () => {
    const res = await invoke(listEvent({ staff: false }));
    expect(res.statusCode).toBe(403);
    expect(sendMock).not.toHaveBeenCalled();
  });
});
