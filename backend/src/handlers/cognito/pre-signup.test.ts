import { describe, expect, it } from "vitest";
import { handler } from "./pre-signup";

function invoke(userAttributes: Record<string, string>, triggerSource = "PreSignUp_SignUp") {
  const event = {
    triggerSource,
    request: { userAttributes },
    response: {},
  };
  return handler(event as never, {} as never, () => undefined);
}

function birthdateForAge(age: number): string {
  const d = new Date();
  d.setFullYear(d.getFullYear() - age);
  d.setDate(d.getDate() - 1); // safely past the birthday
  return d.toISOString().slice(0, 10);
}

describe("pre-signup trigger", () => {
  it("rejects a missing birthdate on native sign-up", async () => {
    await expect(invoke({ email: "a@b.c" })).rejects.toThrow("BIRTHDATE_REQUIRED");
  });

  it("rejects under-13 (COPPA gate)", async () => {
    await expect(invoke({ birthdate: birthdateForAge(12) })).rejects.toThrow("AGE_MINIMUM");
  });

  it("passes a 13+ native sign-up", async () => {
    await expect(invoke({ birthdate: birthdateForAge(13) })).resolves.toBeDefined();
  });

  it("passes federated sign-ups with no birthdate — the DOB gate moves in-app", async () => {
    await expect(invoke({ email: "sso@b.c" }, "PreSignUp_ExternalProvider")).resolves.toBeDefined();
  });
});
