import { beforeEach, describe, expect, it, vi } from "vitest";

const send = vi.hoisted(() => vi.fn());

vi.mock("@aws-sdk/client-cognito-identity-provider", () => ({
  CognitoIdentityProviderClient: class {
    send = send;
  },
  ListUsersCommand: class {
    constructor(readonly input: unknown) {}
  },
}));

import { findAccountByEmail } from "./accounts";

const user = (over: { status?: string; verified?: string; enabled?: boolean; sub?: string } = {}) => ({
  Enabled: over.enabled ?? true,
  UserStatus: over.status ?? "CONFIRMED",
  Attributes: [
    { Name: "sub", Value: over.sub ?? "u-1" },
    { Name: "email", Value: "a@example.com" },
    { Name: "name", Value: "Jordan Miles" },
    { Name: "email_verified", Value: over.verified ?? "true" },
  ],
});

beforeEach(() => {
  send.mockReset();
  process.env.USER_POOL_ID = "us-east-1_test";
});

describe("findAccountByEmail", () => {
  it("returns a confirmed account with a verified email", async () => {
    send.mockResolvedValue({ Users: [user()] });
    await expect(findAccountByEmail(" A@Example.com ")).resolves.toEqual({
      sub: "u-1",
      email: "a@example.com",
      name: "Jordan Miles",
    });
    expect(send.mock.calls[0]![0].input.Filter).toBe('email = "a@example.com"');
  });

  it("ignores an account whose email was never verified", async () => {
    send.mockResolvedValue({ Users: [user({ verified: "false" })] });
    await expect(findAccountByEmail("a@example.com")).resolves.toBeUndefined();
  });

  it("ignores an account with no verified flag at all", async () => {
    const noFlag = user();
    noFlag.Attributes = noFlag.Attributes.filter((a) => a.Name !== "email_verified");
    send.mockResolvedValue({ Users: [noFlag] });
    await expect(findAccountByEmail("a@example.com")).resolves.toBeUndefined();
  });

  it("ignores an unconfirmed account, even with the flag set", async () => {
    send.mockResolvedValue({ Users: [user({ status: "UNCONFIRMED" })] });
    await expect(findAccountByEmail("a@example.com")).resolves.toBeUndefined();
  });

  it("ignores Apple and Google accounts, which cannot sign in to the portal", async () => {
    send.mockResolvedValue({ Users: [user({ status: "EXTERNAL_PROVIDER" })] });
    await expect(findAccountByEmail("a@example.com")).resolves.toBeUndefined();
  });

  it("ignores a disabled account", async () => {
    send.mockResolvedValue({ Users: [user({ enabled: false })] });
    await expect(findAccountByEmail("a@example.com")).resolves.toBeUndefined();
  });

  it("skips an unusable account and finds the good one", async () => {
    send.mockResolvedValue({ Users: [user({ verified: "false", sub: "attacker" }), user({ sub: "real" })] });
    await expect(findAccountByEmail("a@example.com")).resolves.toMatchObject({ sub: "real" });
  });
});
