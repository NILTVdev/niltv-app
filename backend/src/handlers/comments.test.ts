import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sendMock = vi.hoisted(() => vi.fn());

vi.mock("../lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/db")>();
  return { ...actual, getDocClient: () => ({ send: sendMock }) };
});

import { MILD_WORDS, THREAT_PHRASES } from "@niltv/types/comment-filter";
import { handler } from "./comments";

/** Samples come from the word list, so the test file holds no offensive text. */
const MILD = [...MILD_WORDS][0]!;
const THREAT = THREAT_PHRASES[0]!;

async function invoke(event: Record<string, unknown>) {
  const result = await handler(event as never, {} as never, () => undefined);
  if (result === undefined || typeof result === "string") throw new Error("expected a structured result");
  return result;
}

interface EventOpts {
  method: string;
  path: string;
  sub?: string | null;
  body?: unknown;
  query?: Record<string, string>;
  params?: Record<string, string>;
}
const ev = ({ method, path, sub = "u-1", body, query, params }: EventOpts) => ({
  rawPath: path,
  pathParameters: params,
  queryStringParameters: query,
  body: body === undefined ? undefined : JSON.stringify(body),
  isBase64Encoded: false,
  requestContext: {
    http: { method, path },
    authorizer: { jwt: { claims: sub === null ? {} : { sub } } },
  },
});

const sent = () => sendMock.mock.calls.map((c) => (c[0] as { input: Record<string, unknown>; constructor: { name: string } }));
const kinds = () => sent().map((c) => c.constructor.name);

const adultUser = { PK: "USER#u-1", SK: "META", name: "Scott Liu", is18plus: true, commentTermsAcceptedAt: "2026-10-01T00:00:00Z" };
const content = { PK: "CONTENT#c-1", SK: "META", id: "c-1" };

describe("comments handler", () => {
  beforeEach(() => {
    sendMock.mockReset();
    process.env.TABLE_NAME = "niltv-test";
    delete process.env.ORIGIN_VERIFY_SECRET;
  });
  afterEach(() => vi.restoreAllMocks());

  it("401s with no sub claim", async () => {
    const r = await invoke(ev({ method: "GET", path: "/v1/comments", sub: null, query: { contentId: "c-1" } }));
    expect(r.statusCode).toBe(401);
    expect(sendMock).not.toHaveBeenCalled();
  });

  describe("POST /v1/comments", () => {
    const post = (body: unknown) => invoke(ev({ method: "POST", path: "/v1/comments", body }));

    it("403s until the guidelines are accepted", async () => {
      sendMock.mockResolvedValueOnce({ Item: { ...adultUser, commentTermsAcceptedAt: undefined } });
      const r = await post({ contentId: "c-1", body: "Great game" });
      expect(r.statusCode).toBe(403);
      expect(JSON.parse(r.body as string).error).toBe("COMMENT_TERMS_REQUIRED");
    });

    it("publishes a clean comment as visible, author from the token and row", async () => {
      // Rate limiter: Get finds nothing, the increment fails its condition
      // (no window yet), then the Put starts a fresh window.
      sendMock
        .mockResolvedValueOnce({ Item: adultUser })
        .mockResolvedValueOnce({ Item: content })
        .mockResolvedValueOnce({ Item: undefined })
        .mockRejectedValueOnce(Object.assign(new Error("c"), { name: "ConditionalCheckFailedException" }))
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({});
      const r = await post({ contentId: "c-1", body: "Great game!", authorId: "evil", status: "visible" });
      expect(r.statusCode).toBe(201);
      const comment = JSON.parse(r.body as string).comment;
      expect(comment).toMatchObject({ authorId: "u-1", authorName: "Scott L.", status: "visible", contentId: "c-1" });
      const tx = sent().find((c) => c.constructor.name === "TransactWriteCommand");
      const item = (tx?.input["TransactItems"] as Array<{ Put: { Item: Record<string, unknown> } }>)[0]!.Put.Item;
      expect(item["GSI1PK"]).toBe("CCOMMENTS#c-1");
      expect(item["GSI2PK"]).toBeUndefined(); // visible comments are not in the staff queue
    });

    it("holds a link as pending and puts it in the staff queue", async () => {
      sendMock
        .mockResolvedValueOnce({ Item: adultUser })
        .mockResolvedValueOnce({ Item: content })
        .mockResolvedValueOnce({ Item: undefined })
        .mockRejectedValueOnce(Object.assign(new Error("c"), { name: "ConditionalCheckFailedException" }))
        .mockResolvedValue({});
      const r = await post({ contentId: "c-1", body: "see https://example.com" });
      expect(r.statusCode).toBe(201);
      expect(JSON.parse(r.body as string).comment.status).toBe("pending");
      const tx = sent().find((c) => c.constructor.name === "TransactWriteCommand");
      const item = (tx?.input["TransactItems"] as Array<{ Put: { Item: Record<string, unknown> } }>)[0]!.Put.Item;
      expect(item["GSI2PK"]).toBe("MODQ#open");
    });

    it("treats a user without is18plus=true as a minor (fails closed)", async () => {
      sendMock
        .mockResolvedValueOnce({ Item: { ...adultUser, is18plus: undefined } })
        .mockResolvedValueOnce({ Item: content })
        .mockResolvedValueOnce({ Item: undefined })
        .mockRejectedValueOnce(Object.assign(new Error("c"), { name: "ConditionalCheckFailedException" }))
        .mockResolvedValue({});
      const r = await post({ contentId: "c-1", body: `that was ${MILD} great` });
      expect(JSON.parse(r.body as string).comment.status).toBe("pending");
    });

    it("rejects objectionable text with a generic error and writes nothing", async () => {
      sendMock
        .mockResolvedValueOnce({ Item: adultUser })
        .mockResolvedValueOnce({ Item: content })
        .mockResolvedValueOnce({ Item: undefined })
        .mockRejectedValueOnce(Object.assign(new Error("c"), { name: "ConditionalCheckFailedException" }))
        .mockResolvedValue({});
      const r = await post({ contentId: "c-1", body: THREAT });
      expect(r.statusCode).toBe(422);
      expect(JSON.parse(r.body as string)).toEqual({ error: "COMMENT_REJECTED" });
      expect(kinds()).not.toContain("TransactWriteCommand");
    });

    it("429s when the rate window is full", async () => {
      const cond = Object.assign(new Error("c"), { name: "ConditionalCheckFailedException" });
      sendMock
        .mockResolvedValueOnce({ Item: adultUser })
        .mockResolvedValueOnce({ Item: content })
        .mockResolvedValueOnce({ Item: undefined })
        .mockRejectedValueOnce(cond) // increment: window full / absent
        .mockRejectedValueOnce(cond); // reset: window still live
      const r = await post({ contentId: "c-1", body: "hello there" });
      expect(r.statusCode).toBe(429);
      expect(JSON.parse(r.body as string).error).toBe("COMMENT_RATE_LIMITED");
    });

    it("refuses a duplicate of the last comment", async () => {
      const { bodyHash } = await import("../lib/comments");
      sendMock
        .mockResolvedValueOnce({ Item: adultUser })
        .mockResolvedValueOnce({ Item: content })
        .mockResolvedValueOnce({ Item: { lastHash: bodyHash("Hello there!"), lastHashAt: Date.now() - 1000 } });
      const r = await post({ contentId: "c-1", body: "hello THERE" });
      expect(r.statusCode).toBe(429);
    });

    it("400s on an empty or oversized body", async () => {
      expect((await post({ contentId: "c-1", body: "   " })).statusCode).toBe(400);
      expect((await post({ contentId: "c-1", body: "a".repeat(501) })).statusCode).toBe(400);
      expect(sendMock).not.toHaveBeenCalled();
    });
  });

  describe("GET /v1/comments", () => {
    const list = (query: Record<string, string>) => invoke(ev({ method: "GET", path: "/v1/comments", query }));
    const row = (id: string, authorId: string, status = "visible") => ({
      id, contentId: "c-1", authorId, authorName: "X", body: `b-${id}`, status, createdAt: "2026-10-01T00:00:00.000Z",
    });

    it("hides blocked authors, comments the caller reported, and others' pending comments", async () => {
      sendMock
        .mockResolvedValueOnce({ Item: content })
        .mockResolvedValueOnce({ Items: [{ SK: "BLOCK#u-bad" }] })
        .mockResolvedValueOnce({ Items: [{ SK: "REPORTED#r1" }] })
        .mockResolvedValueOnce({
          Items: [
            row("ok", "u-2"),
            row("blocked", "u-bad"),
            row("r1", "u-3"),
            row("theirs-pending", "u-4", "pending"),
            row("mine-pending", "u-1", "pending"),
            row("hidden", "u-5", "hidden"),
          ],
        });
      const r = await list({ contentId: "c-1" });
      expect(r.statusCode).toBe(200);
      expect(r.headers?.["cache-control"]).toBe("private, no-store");
      const ids = JSON.parse(r.body as string).comments.map((c: { id: string }) => c.id);
      expect(ids).toEqual(["ok", "mine-pending"]);
    });

    it("never leaks moderation fields", async () => {
      sendMock
        .mockResolvedValueOnce({ Item: content })
        .mockResolvedValueOnce({ Items: [] })
        .mockResolvedValueOnce({ Items: [] })
        .mockResolvedValueOnce({ Items: [{ ...row("a", "u-2"), reportCount: 2, authorIs18plus: false, GSI1PK: "x" }] });
      const body = JSON.parse((await list({ contentId: "c-1" })).body as string);
      expect(Object.keys(body.comments[0]).sort()).toEqual(["authorId", "authorName", "body", "contentId", "createdAt", "id", "status"]);
    });

    it("rejects a cursor aimed at another partition", async () => {
      sendMock.mockResolvedValueOnce({ Item: content });
      const cursor = Buffer.from(JSON.stringify({ GSI1PK: "CCOMMENTS#other", GSI1SK: "x" })).toString("base64url");
      expect((await list({ contentId: "c-1", cursor })).statusCode).toBe(400);
    });

    it("404s for a missing or removed clip, 400s without contentId", async () => {
      sendMock.mockResolvedValueOnce({ Item: undefined });
      expect((await list({ contentId: "nope" })).statusCode).toBe(404);
      expect((await list({})).statusCode).toBe(400);
    });
  });

  describe("PATCH/DELETE /v1/comments/{id}", () => {
    const own = { id: "k1", authorId: "u-1", authorName: "Scott L.", body: "old text", contentId: "c-1", createdAt: "2026-10-01T00:00:00.000Z", status: "visible", reportCount: 0 };
    const edit = (body: unknown) =>
      invoke(ev({ method: "PATCH", path: "/v1/comments/k1", params: { commentId: "k1" }, body }));
    const del = (sub = "u-1") =>
      invoke(ev({ method: "DELETE", path: "/v1/comments/k1", params: { commentId: "k1" }, sub }));
    const cond = Object.assign(new Error("c"), { name: "ConditionalCheckFailedException" });

    it("404s when editing or deleting someone else's comment", async () => {
      sendMock.mockResolvedValueOnce({ Item: { ...own, authorId: "u-9" } });
      expect((await edit({ body: "changed" })).statusCode).toBe(404);
      sendMock.mockResolvedValueOnce({ Item: { ...own, authorId: "u-9" } });
      expect((await del()).statusCode).toBe(404);
      expect(kinds().filter((k) => k !== "GetCommand")).toEqual([]);
    });

    it("locks editing of a comment hidden by reports", async () => {
      sendMock.mockResolvedValueOnce({ Item: { ...own, status: "hidden" } });
      const r = await edit({ body: "changed" });
      expect(r.statusCode).toBe(403);
      expect(JSON.parse(r.body as string).error).toBe("COMMENT_LOCKED");
    });

    it("re-runs the filter on edit: a clean comment edited into a slur is refused", async () => {
      sendMock
        .mockResolvedValueOnce({ Item: own })
        .mockResolvedValueOnce({ Item: adultUser })
        .mockResolvedValueOnce({ Item: undefined })
        .mockRejectedValueOnce(cond)
        .mockResolvedValue({});
      const r = await edit({ body: THREAT });
      expect(r.statusCode).toBe(422);
      const wrote = sent().filter((c) => c.constructor.name === "UpdateCommand" && String(c.input["UpdateExpression"]).includes("editedAt"));
      expect(wrote).toEqual([]);
    });

    it("edit conditions the write on author and live status", async () => {
      sendMock
        .mockResolvedValueOnce({ Item: own })
        .mockResolvedValueOnce({ Item: adultUser })
        .mockResolvedValueOnce({ Item: undefined })
        .mockRejectedValueOnce(cond)
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ Attributes: { ...own, body: "new text", editedAt: "2026-10-02T00:00:00.000Z" } })
        .mockResolvedValueOnce({});
      const r = await edit({ body: "new text" });
      expect(r.statusCode).toBe(200);
      const update = sent().filter((c) => c.constructor.name === "UpdateCommand").find((c) => String(c.input["UpdateExpression"]).includes("editedAt"));
      expect(update?.input["ConditionExpression"]).toContain("authorId = :sub");
      expect(JSON.parse(r.body as string).comment.editedAt).toBe("2026-10-02T00:00:00.000Z");
    });

    it("hard-deletes an unreported comment and tombstones a reported one", async () => {
      sendMock.mockResolvedValueOnce({ Item: own }).mockResolvedValueOnce({});
      expect((await del()).statusCode).toBe(200);
      expect(kinds()).toContain("TransactWriteCommand");

      sendMock.mockReset();
      sendMock.mockResolvedValueOnce({ Item: { ...own, reportCount: 2 } }).mockResolvedValueOnce({});
      expect((await del()).statusCode).toBe(200);
      expect(kinds()).toEqual(["GetCommand", "UpdateCommand"]);
    });
  });

  describe("POST /v1/comments/{id}/report", () => {
    const report = (sub = "u-2") =>
      invoke(ev({ method: "POST", path: "/v1/comments/k1/report", params: { commentId: "k1" }, sub, body: { reason: "spam" } }));
    const row = { id: "k1", authorId: "u-1", createdAt: "2026-10-01T00:00:00.000Z", status: "visible" };

    it("refuses self-reports and bad reasons", async () => {
      sendMock.mockResolvedValueOnce({ Item: row });
      expect((await report("u-1")).statusCode).toBe(400);
      const bad = await invoke(ev({ method: "POST", path: "/v1/comments/k1/report", params: { commentId: "k1" }, sub: "u-2", body: { reason: "nope" } }));
      expect(bad.statusCode).toBe(400);
    });

    it("is idempotent per reporter: a repeat report changes nothing", async () => {
      sendMock.mockResolvedValueOnce({ Item: row }).mockRejectedValueOnce(
        Object.assign(new Error("x"), { name: "TransactionCanceledException", CancellationReasons: [{ Code: "ConditionalCheckFailed" }, { Code: "None" }, { Code: "None" }] }),
      );
      expect((await report()).statusCode).toBe(200);
      expect(kinds()).toEqual(["GetCommand", "TransactWriteCommand"]);
    });

    it("hides the comment only through a threshold-conditioned update", async () => {
      sendMock.mockResolvedValueOnce({ Item: row }).mockResolvedValueOnce({}).mockResolvedValueOnce({});
      expect((await report()).statusCode).toBe(200);
      const hide = sent().find((c) => c.constructor.name === "UpdateCommand");
      expect(hide?.input["ConditionExpression"]).toContain("reportCount >= :threshold");
      expect((hide?.input["ExpressionAttributeValues"] as Record<string, unknown>)[":threshold"]).toBe(3);
    });
  });

  it("PUT /v1/me/comment-terms stamps the user row once", async () => {
    sendMock.mockResolvedValueOnce({});
    const r = await invoke(ev({ method: "PUT", path: "/v1/me/comment-terms" }));
    expect(r.statusCode).toBe(200);
    expect(sent()[0]?.input["UpdateExpression"]).toContain("if_not_exists(commentTermsAcceptedAt");
  });
});
