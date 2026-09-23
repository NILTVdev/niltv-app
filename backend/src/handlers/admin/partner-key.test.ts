import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sendMock = vi.hoisted(() => vi.fn());

vi.mock("../../lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/db")>();
  return { ...actual, getDocClient: () => ({ send: sendMock }) };
});

import { handler, liveKeyHashes } from "./partner-key";

type TransactItem = { Put?: { Item: Record<string, unknown> }; Update?: { Key: { PK: string }; UpdateExpression: string } };

const invoke = (action: "rotate-key" | "revoke-key") =>
  handler(
    {
      pathParameters: { id: "p-example" },
      rawPath: `/admin/partners/p-example/${action}`,
      requestContext: { authorizer: { jwt: { claims: { "cognito:groups": "[staff]" } } }, http: { path: `/admin/partners/p-example/${action}` } },
    } as never,
    {} as never,
    () => undefined,
  ) as Promise<{ statusCode: number; body?: string }>;

const transactItems = (): TransactItem[] =>
  (sendMock.mock.calls.find((c) => (c[0] as { input: { TransactItems?: unknown } }).input.TransactItems)?.[0] as { input: { TransactItems: TransactItem[] } })
    .input.TransactItems;

describe("POST /admin/partners/{id}/rotate-key · /revoke-key", () => {
  beforeEach(() => {
    sendMock.mockReset();
    sendMock.mockResolvedValue({});
    process.env.TABLE_NAME = "niltv-test";
    process.env.PARTNER_KEY_PEPPER = "pepper";
    process.env.STAGE = "test";
  });
  afterEach(() => {
    delete process.env.PARTNER_KEY_PEPPER;
  });

  it("liveKeyHashes merges the active hash with the tracked list, newest first, no duplicates", () => {
    expect(liveKeyHashes({ activeKeyHash: "b", keyHashes: ["b", "a"] })).toEqual(["b", "a"]);
    expect(liveKeyHashes({ activeKeyHash: "b" })).toEqual(["b"]);
    expect(liveKeyHashes({})).toEqual([]);
  });

  it("rotate: new key active, outgoing key gets grace, any older grace key is revoked now", async () => {
    sendMock.mockResolvedValueOnce({ Item: { id: "p-example", activeKeyHash: "h2", keyHashes: ["h2", "h1"] } });
    const result = await invoke("rotate-key");
    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body ?? "{}") as { status: string; apiKey: string; previousKeyExpiresAt?: string };
    expect(body.status).toBe("rotated");
    expect(body.apiKey).toMatch(/^nltv_test_[A-Za-z0-9]{32}$/);
    expect(body.previousKeyExpiresAt).toBeDefined();

    const items = transactItems();
    const puts = items.filter((i) => i.Put);
    expect(puts).toHaveLength(1);
    const updates = items.filter((i) => i.Update).map((i) => i.Update!);
    expect(updates.find((u) => u.Key.PK === "PARTNERKEY#h2")?.UpdateExpression).toContain("expiresAt");
    expect(updates.find((u) => u.Key.PK === "PARTNERKEY#h1")?.UpdateExpression).toContain("revokedAt");
    const partnerUpdate = updates.find((u) => u.Key.PK === "PARTNER#p-example");
    expect(partnerUpdate?.UpdateExpression).toContain("keyHashes = :hashes");
  });

  it("revoke: every live hash gets revokedAt, not just the active one", async () => {
    sendMock.mockResolvedValueOnce({ Item: { id: "p-example", activeKeyHash: "h3", keyHashes: ["h3", "h2"] } });
    const result = await invoke("revoke-key");
    expect(result.statusCode).toBe(200);
    const updates = transactItems().filter((i) => i.Update).map((i) => i.Update!);
    const revoked = updates.filter((u) => u.UpdateExpression.includes("revokedAt")).map((u) => u.Key.PK).sort();
    expect(revoked).toEqual(["PARTNERKEY#h2", "PARTNERKEY#h3"]);
    expect(updates.find((u) => u.Key.PK === "PARTNER#p-example")?.UpdateExpression).toContain("REMOVE activeKeyHash, keyPrefix");
  });

  it("revoke on a partner that still has a legacy row (activeKeyHash only) revokes that key", async () => {
    sendMock.mockResolvedValueOnce({ Item: { id: "p-example", activeKeyHash: "h1" } });
    await invoke("revoke-key");
    const revoked = transactItems().filter((i) => i.Update?.UpdateExpression.includes("revokedAt")).map((i) => i.Update!.Key.PK);
    expect(revoked).toEqual(["PARTNERKEY#h1"]);
  });

  it("404s an unknown partner and 403s a non-staff caller", async () => {
    sendMock.mockResolvedValueOnce({ Item: undefined });
    expect((await invoke("revoke-key")).statusCode).toBe(404);
    const fan = await handler(
      { pathParameters: { id: "p-example" }, rawPath: "/admin/partners/p-example/revoke-key", requestContext: { authorizer: { jwt: { claims: {} } }, http: { path: "/x" } } } as never,
      {} as never,
      () => undefined,
    );
    expect((fan as { statusCode: number }).statusCode).toBe(403);
  });
});
