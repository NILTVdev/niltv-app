/**
 * Cognito pre-token-generation trigger (design §6.2): stamps `custom:is18plus`
 * and `custom:role` into the ID token from the stored USER row — the source of
 * truth frozen at confirmation. Deriving from the live birthdate attribute is
 * deliberately avoided: birthdate must stay client-writable for self-signup
 * (Cognito requires write access to required attributes), so a later
 * UpdateUserAttributes call must never be able to re-derive 18+ status.
 * Fail closed: no row (or a read error) stamps "false" / "fan".
 *
 * It also HEALS a missing USER row (what post-confirmation's "never throws —
 * the row can be healed on first authed request" always intended). Three
 * populations arrive here without one:
 *   - federated sign-ins: Cognito does NOT fire post-confirmation for external
 *     providers, so every Apple/Google account would otherwise 404 on /v1/me
 *     and lose follows/likes/votes entirely;
 *   - staff created with admin-create-user (no confirmation ever runs);
 *   - anyone whose post-confirmation write failed.
 * Healing here rather than in a read handler is deliberate: this trigger only
 * runs when Cognito has just authenticated a live account, so a deleted
 * account can never resurrect its row off a still-valid JWT (design §6.6).
 * The healed row is fail-closed too — is18plus comes from a birthdate
 * attribute when the provider supplied one, false otherwise, so an unproven
 * DOB cannot vote until the in-app DOB step fills it in.
 */
import type { PreTokenGenerationTriggerHandler } from "aws-lambda";
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { User } from "@niltv/types";
import { is18Plus } from "../../lib/age";
import { getDocClient, userKey } from "../../lib/db";

/** The row this account should have had at confirmation; undefined if unidentifiable. */
export function healedUser(
  sub: string,
  attrs: Record<string, string>,
  now: Date = new Date(),
): User | undefined {
  const email = (attrs["email"] ?? "").trim().toLowerCase();
  if (!email.includes("@")) return undefined;
  const birthdate = attrs["birthdate"] ?? "";
  return User.parse({
    id: sub,
    name: attrs["name"] || email.split("@")[0] || "",
    email,
    role: "fan",
    is18plus: birthdate.length > 0 && is18Plus(birthdate, now),
    pushEnabled: false,
    createdAt: now.toISOString(),
  });
}

export const handler: PreTokenGenerationTriggerHandler = async (event) => {
  let is18plus = false;
  let role = "fan";

  const attrs = event.request.userAttributes ?? {};
  const sub = attrs["sub"] ?? event.userName;

  try {
    const db = getDocClient();
    const table = process.env.TABLE_NAME;
    const { Item } = await db.send(
      new GetCommand({ TableName: table, Key: userKey(sub) }),
    );

    if (Item) {
      is18plus = Item["is18plus"] === true;
      role = typeof Item["role"] === "string" ? Item["role"] : "fan";
    } else {
      const user = healedUser(sub, attrs);
      if (user) {
        await db.send(
          new PutCommand({
            TableName: table,
            Item: { ...userKey(user.id), ...user },
            // Lose the race gracefully: a concurrent confirmation wins.
            ConditionExpression: "attribute_not_exists(PK)",
          }),
        );
        is18plus = user.is18plus;
        role = user.role;
      }
    }
  } catch (err) {
    // Fail closed — an unreadable/unwritable row must never grant 18+ or a
    // non-fan role. The next sign-in retries the heal.
    console.error("pre-token: USER row read/heal failed, stamping fail-closed claims", err);
  }

  event.response = {
    claimsOverrideDetails: {
      claimsToAddOrOverride: {
        "custom:is18plus": is18plus ? "true" : "false",
        "custom:role": role,
      },
    },
  };

  return event;
};
