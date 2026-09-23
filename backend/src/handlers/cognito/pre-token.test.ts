import { beforeEach, describe, expect, it, vi } from "vitest";

const sendMock = vi.hoisted(() => vi.fn());

vi.mock("../../lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/db")>();
  return {
    ...actual,
    getDocClient: () => ({ send: sendMock }),
  };
});

import { handler } from "./pre-token";

function makeEvent(sub = "user-123") {
  return {
    userName: sub,
    request: { userAttributes: { sub, birthdate: "1990-01-01" } },
    response: {},
  };
}

async function claims(event = makeEvent()) {
  const result = (await handler(event as never, {} as never, () => undefined)) as unknown as {
    response: { claimsOverrideDetails: { claimsToAddOrOverride: Record<string, string> } };
  };
  return result.response.claimsOverrideDetails.claimsToAddOrOverride;
}

describe("pre-token trigger — claims from the stored USER row", () => {
  beforeEach(() => {
    sendMock.mockReset();
    process.env.TABLE_NAME = "niltv-test";
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  it("stamps is18plus/role from the row, ignoring the live birthdate attribute", async () => {
    sendMock.mockResolvedValueOnce({ Item: { is18plus: true, role: "ambassador" } });
    // Event birthdate says adult too, but the row is what must decide.
    const c = await claims();
    expect(c["custom:is18plus"]).toBe("true");
    expect(c["custom:role"]).toBe("ambassador");
  });

  it("fails closed when the USER row is missing", async () => {
    sendMock.mockResolvedValueOnce({});
    const c = await claims();
    expect(c["custom:is18plus"]).toBe("false");
    expect(c["custom:role"]).toBe("fan");
  });

  it("fails closed when the read errors — adult birthdate attribute must not leak through", async () => {
    sendMock.mockRejectedValueOnce(new Error("ddb down"));
    const c = await claims();
    expect(c["custom:is18plus"]).toBe("false");
    expect(c["custom:role"]).toBe("fan");
  });
});

describe("pre-token USER row healing", () => {
  it("heals a missing row from provider attributes and stamps the derived claims", async () => {
    sendMock.mockReset();
    sendMock.mockResolvedValueOnce({}); // Get: no row (federated first sign-in)
    sendMock.mockResolvedValueOnce({}); // Put: heal succeeds
    const event = {
      userName: "signinwithapple_001",
      request: {
        userAttributes: { sub: "u-sso", email: "SSO@Example.com", name: "Ada Sso" },
      },
      response: {},
    };
    const out = await handler(event as never, {} as never, () => undefined);
    const put = sendMock.mock.calls[1]?.[0]?.input;
    expect(put?.Item).toMatchObject({
      PK: "USER#u-sso",
      id: "u-sso",
      email: "sso@example.com",
      name: "Ada Sso",
      role: "fan",
      is18plus: false, // no birthdate from the IdP — voting stays locked
      pushEnabled: false,
    });
    expect(put?.ConditionExpression).toBe("attribute_not_exists(PK)");
    expect(
      (out as { response: { claimsOverrideDetails: { claimsToAddOrOverride: Record<string, string> } } })
        .response.claimsOverrideDetails.claimsToAddOrOverride,
    ).toEqual({ "custom:is18plus": "false", "custom:role": "fan" });
  });

  it("does not heal without a usable email, and stays fail-closed", async () => {
    sendMock.mockReset();
    sendMock.mockResolvedValueOnce({});
    const event = {
      userName: "u-2",
      request: { userAttributes: { sub: "u-2" } },
      response: {},
    };
    await handler(event as never, {} as never, () => undefined);
    expect(sendMock).toHaveBeenCalledTimes(1); // Get only — no Put attempted
  });

  it("stamps 18+ when the provider supplied an adult birthdate", async () => {
    sendMock.mockReset();
    sendMock.mockResolvedValueOnce({});
    sendMock.mockResolvedValueOnce({});
    const event = {
      userName: "u-3",
      request: {
        userAttributes: { sub: "u-3", email: "adult@example.com", birthdate: "1990-01-01" },
      },
      response: {},
    };
    const out = await handler(event as never, {} as never, () => undefined);
    expect(sendMock.mock.calls[1]?.[0]?.input?.Item).toMatchObject({ is18plus: true });
    expect(
      (out as { response: { claimsOverrideDetails: { claimsToAddOrOverride: Record<string, string> } } })
        .response.claimsOverrideDetails.claimsToAddOrOverride["custom:is18plus"],
    ).toBe("true");
  });

  it("keeps serving fail-closed claims when the heal write fails", async () => {
    sendMock.mockReset();
    sendMock.mockResolvedValueOnce({});
    sendMock.mockRejectedValueOnce(new Error("throttled"));
    const event = {
      userName: "u-4",
      request: { userAttributes: { sub: "u-4", email: "x@example.com", birthdate: "1990-01-01" } },
      response: {},
    };
    const out = await handler(event as never, {} as never, () => undefined);
    expect(
      (out as { response: { claimsOverrideDetails: { claimsToAddOrOverride: Record<string, string> } } })
        .response.claimsOverrideDetails.claimsToAddOrOverride,
    ).toEqual({ "custom:is18plus": "false", "custom:role": "fan" });
  });
});
