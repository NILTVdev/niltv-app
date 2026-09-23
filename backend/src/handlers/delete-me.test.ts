import { beforeEach, describe, expect, it, vi } from "vitest";

const sendMock = vi.hoisted(() => vi.fn());
const cognitoSendMock = vi.hoisted(() => vi.fn());

vi.mock("../lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/db")>();
  return {
    ...actual,
    getDocClient: () => ({ send: sendMock }),
  };
});

vi.mock("@aws-sdk/client-cognito-identity-provider", () => {
  class UserNotFoundException extends Error {}
  return {
    CognitoIdentityProviderClient: class {
      send = cognitoSendMock;
    },
    AdminDeleteUserCommand: class {
      constructor(public readonly input: Record<string, unknown>) {}
    },
    UserNotFoundException,
  };
});

import { UserNotFoundException } from "@aws-sdk/client-cognito-identity-provider";
import { anonymousHash, handler } from "./delete-me";

async function invoke(event: Record<string, unknown>) {
  const result = await handler(event as never, {} as never, () => undefined);
  if (result === undefined || typeof result === "string") {
    throw new Error("expected a structured APIGatewayProxyStructuredResultV2");
  }
  return result;
}

const makeEvent = (sub: string | null = "u-1") => ({
  requestContext: {
    http: { method: "DELETE" },
    authorizer: {
      jwt: { claims: sub === null ? {} : { sub, "cognito:username": "fan@example.com" } },
    },
  },
});

/** One-command view of everything sent to DynamoDB, in order. */
const dbCalls = () =>
  sendMock.mock.calls.map((c) => {
    const cmd = c[0] as { constructor: { name: string }; input: Record<string, any> };
    return { kind: cmd.constructor.name, input: cmd.input };
  });

describe("DELETE /v1/me handler (design §6.6)", () => {
  beforeEach(() => {
    sendMock.mockReset();
    sendMock.mockResolvedValue({});
    cognitoSendMock.mockReset();
    cognitoSendMock.mockResolvedValue({});
    process.env.TABLE_NAME = "niltv-test";
    process.env.USER_POOL_ID = "us-east-1_test";
    delete process.env.ORIGIN_VERIFY_SECRET;
  });

  it("returns 401 when the JWT sub claim is missing", async () => {
    const res = await invoke(makeEvent(null));
    expect(res.statusCode).toBe(401);
    expect(sendMock).not.toHaveBeenCalled();
    expect(cognitoSendMock).not.toHaveBeenCalled();
  });

  it("anonymizes votes, deletes facts with counters, unsubscribes, then deletes Cognito", async () => {
    sendMock.mockResolvedValueOnce({
      Items: [
        { PK: "USER#u-1", SK: "META", email: "Fan@Example.com", name: "Fan" },
        {
          PK: "USER#u-1",
          SK: "VOTE#ev-1",
          entryId: "en-9",
          GSI1PK: "EVENT#ev-1",
          GSI1SK: "VOTE#en-9#u-1",
          createdAt: "2026-07-20T00:00:00.000Z",
          source: "app",
        },
        { PK: "USER#u-1", SK: "FOLLOW#ath-camila" },
        { PK: "USER#u-1", SK: "LIKE#c-1" },
        { PK: "USER#u-1", SK: "DEVICE#tok-1" },
        { PK: "USER#u-1", SK: "NOTIF#channel#ch-tbtv" },
      ],
    });

    const res = await invoke(makeEvent());
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body ?? "")).toEqual({ status: "ok" });

    const calls = dbCalls();
    const hash = anonymousHash("u-1");

    // Vote: anonymized copy first, then the original is deleted — tally intact.
    const anonPut = calls.find((c) => c.kind === "PutCommand");
    expect(anonPut?.input["Item"]).toMatchObject({
      PK: `USER#deleted#${hash}`,
      SK: "VOTE#ev-1",
      entryId: "en-9",
      GSI1PK: "EVENT#ev-1",
      GSI1SK: `VOTE#en-9#deleted#${hash}`,
    });

    // Follow + like go through the counter transaction (delete + ADD −1).
    const transacts = calls.filter((c) => c.kind === "TransactWriteCommand");
    expect(transacts).toHaveLength(2);

    // Deletes: vote original, device, notif, SUB row (normalized email), META.
    const deleteKeys = calls
      .filter((c) => c.kind === "DeleteCommand")
      .map((c) => c.input["Key"]);
    expect(deleteKeys).toContainEqual({ PK: "USER#u-1", SK: "VOTE#ev-1" });
    expect(deleteKeys).toContainEqual({ PK: "USER#u-1", SK: "DEVICE#tok-1" });
    expect(deleteKeys).toContainEqual({ PK: "USER#u-1", SK: "NOTIF#channel#ch-tbtv" });
    expect(deleteKeys).toContainEqual({ PK: "SUB#fan@example.com", SK: "META" });
    // META last.
    expect(deleteKeys[deleteKeys.length - 1]).toEqual({ PK: "USER#u-1", SK: "META" });

    // Cognito delete uses the username claim, not the sub.
    const cognito = cognitoSendMock.mock.calls[0]?.[0] as { input: Record<string, unknown> };
    expect(cognito.input).toEqual({ UserPoolId: "us-east-1_test", Username: "fan@example.com" });
  });

  it("an already-deleted Cognito user is still success (retry path)", async () => {
    sendMock.mockResolvedValueOnce({ Items: [] });
    cognitoSendMock.mockRejectedValueOnce(new UserNotFoundException("gone" as never));
    const res = await invoke(makeEvent());
    expect(res.statusCode).toBe(200);
  });

  it("a follow whose athlete row is gone falls back to a plain delete", async () => {
    sendMock.mockReset();
    sendMock
      .mockResolvedValueOnce({
        Items: [
          { PK: "USER#u-1", SK: "META", email: "fan@example.com" },
          { PK: "USER#u-1", SK: "FOLLOW#ath-gone" },
        ],
      })
      // counter transaction trips its condition…
      .mockRejectedValueOnce(
        Object.assign(new Error("cancelled"), {
          name: "TransactionCanceledException",
          CancellationReasons: [{ Code: "None" }, { Code: "ConditionalCheckFailed" }],
        }),
      )
      .mockResolvedValue({});

    const res = await invoke(makeEvent());
    expect(res.statusCode).toBe(200);
    // …and the fact row is still deleted directly.
    const deleteKeys = dbCalls()
      .filter((c) => c.kind === "DeleteCommand")
      .map((c) => c.input["Key"]);
    expect(deleteKeys).toContainEqual({ PK: "USER#u-1", SK: "FOLLOW#ath-gone" });
  });
});
