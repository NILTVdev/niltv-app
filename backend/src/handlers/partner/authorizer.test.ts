import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hashApiKey } from "../../lib/partner-keys";

const sendMock = vi.hoisted(() => vi.fn());

vi.mock("../../lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/db")>();
  return { ...actual, getDocClient: () => ({ send: sendMock }) };
});

import { handler } from "./authorizer";

const KEY = "nltv_test_" + "a".repeat(32);
const PEPPER = "pepper-for-tests";

const event = (headers: Record<string, string> = {}) =>
  ({ headers, requestContext: {}, routeArn: "arn", identitySource: [] }) as never;

describe("partner API key authorizer", () => {
  beforeEach(() => {
    sendMock.mockReset();
    process.env.TABLE_NAME = "niltv-test";
    process.env.PARTNER_KEY_PEPPER = PEPPER;
  });
  afterEach(() => {
    delete process.env.PARTNER_KEY_PEPPER;
  });

  it("denies without touching the table when the header is missing or malformed", async () => {
    expect(await handler(event())).toEqual({ isAuthorized: false, context: {} });
    expect(await handler(event({ "x-api-key": "not-a-key" }))).toEqual({ isAuthorized: false, context: {} });
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("looks the key up by its salted hash and returns the partner id", async () => {
    sendMock
      .mockResolvedValueOnce({ Item: { partnerId: "p-example", createdAt: "2026-09-01T00:00:00Z" } })
      .mockResolvedValueOnce({ Item: { id: "p-example", status: "active" } });
    const result = await handler(event({ "x-api-key": KEY }));
    expect(result).toEqual({ isAuthorized: true, context: { partnerId: "p-example" } });
    const lookup = sendMock.mock.calls[0]?.[0] as { input: { Key: { PK: string } } };
    expect(lookup.input.Key.PK).toBe(`PARTNERKEY#${hashApiKey(PEPPER, KEY)}`);
  });

  it("denies an unknown, expired or revoked key and a suspended partner", async () => {
    sendMock.mockResolvedValueOnce({ Item: undefined });
    expect((await handler(event({ "x-api-key": KEY }))).isAuthorized).toBe(false);

    sendMock.mockReset();
    sendMock.mockResolvedValueOnce({ Item: { partnerId: "p-example", expiresAt: "2020-01-01T00:00:00Z" } });
    expect((await handler(event({ "x-api-key": KEY }))).isAuthorized).toBe(false);

    sendMock.mockReset();
    sendMock.mockResolvedValueOnce({ Item: { partnerId: "p-example", revokedAt: "2026-09-01T00:00:00Z" } });
    expect((await handler(event({ "x-api-key": KEY }))).isAuthorized).toBe(false);

    sendMock.mockReset();
    sendMock
      .mockResolvedValueOnce({ Item: { partnerId: "p-example" } })
      .mockResolvedValueOnce({ Item: { id: "p-example", status: "suspended" } });
    expect((await handler(event({ "x-api-key": KEY }))).isAuthorized).toBe(false);
  });

  it("fails closed on a thrown error", async () => {
    sendMock.mockRejectedValueOnce(new Error("dynamo down"));
    expect((await handler(event({ "x-api-key": KEY }))).isAuthorized).toBe(false);
  });
});
