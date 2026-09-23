/**
 * Cognito post-confirmation trigger (design §6.2): writes the USER#{sub}/META
 * profile row. Never throws — a failed profile write must not block the user's
 * confirmation (the row can be healed on first authed request).
 */
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { User } from "@niltv/types";
import type { PostConfirmationTriggerHandler } from "aws-lambda";
import { is18Plus } from "../../lib/age";
import { getDocClient, userKey } from "../../lib/db";

export const handler: PostConfirmationTriggerHandler = async (event) => {
  try {
    const attrs = event.request.userAttributes;
    const sub = attrs["sub"] ?? event.userName;
    const email = attrs["email"] ?? "";
    const name = attrs["name"] ?? email.split("@")[0] ?? "";

    const user = User.parse({
      id: sub,
      name,
      email,
      role: "fan",
      is18plus: is18Plus(attrs["birthdate"] ?? ""),
      pushEnabled: false,
      createdAt: new Date().toISOString(),
    });

    // Plain item, no GSI attributes — user rows are only ever fetched by key.
    await getDocClient().send(
      new PutCommand({
        TableName: process.env.TABLE_NAME ?? "",
        Item: { ...userKey(user.id), ...user },
      }),
    );
  } catch (err) {
    console.error("post-confirmation: USER item write failed (confirmation proceeds)", err);
  }

  return event;
};
