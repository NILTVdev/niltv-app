/**
 * POST /v1/me/devices · PUT /v1/me/push (JWT) — the push opt-in pair
 * (design §6.2 tail, §7): device registration upserts the token row (with its
 * DEVICES#ALL broadcast mirror) and flips the user's global toggle on —
 * registering IS opting in. The Profile toggle then writes pushEnabled
 * directly; fanout checks it per send, so muting never deletes tokens.
 */
import { PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { AckResponse, DeviceRegisterRequest, PushToggleRequest } from "@niltv/types";
import type { APIGatewayProxyHandlerV2WithJWTAuthorizer } from "aws-lambda";
import { deviceGsi, deviceKey, getDocClient, userKey } from "../lib/db";
import { badRequest, forbidden, json, notFound, parseJsonBody, unauthorized } from "../lib/http";
import { requireOriginVerify } from "../lib/origin";

const isConditionalCheckFailed = (err: unknown): boolean =>
  typeof err === "object" && err !== null && (err as { name?: string }).name === "ConditionalCheckFailedException";

export const handler: APIGatewayProxyHandlerV2WithJWTAuthorizer = async (event) => {
  // Origin lockdown: only CloudFront (which injects x-origin-verify) may call.
  if (!requireOriginVerify(event)) return forbidden();

  // Fail closed: no usable sub claim → 401, never a guess (conventions §Auth).
  const sub = event.requestContext?.authorizer?.jwt?.claims?.["sub"];
  if (typeof sub !== "string" || sub.length === 0) return unauthorized();

  const path = event.rawPath ?? event.requestContext?.http?.path ?? "";
  const body = parseJsonBody(event.body, event.isBase64Encoded === true);
  const db = getDocClient();
  const table = process.env.TABLE_NAME ?? "";

  // Guarded toggle write shared by both routes. The attribute_exists condition
  // keeps a stale JWT from resurrecting a deleted account's partition (§6.6).
  const setPushEnabled = async (enabled: boolean): Promise<boolean> => {
    try {
      await db.send(
        new UpdateCommand({
          TableName: table,
          Key: userKey(sub),
          ConditionExpression: "attribute_exists(PK)",
          UpdateExpression: "SET pushEnabled = :enabled",
          ExpressionAttributeValues: { ":enabled": enabled },
        }),
      );
      return true;
    } catch (err) {
      if (isConditionalCheckFailed(err)) return false;
      throw err;
    }
  };

  if (path.endsWith("/devices")) {
    const request = DeviceRegisterRequest.safeParse(body);
    if (!request.success) return badRequest();
    const { expoPushToken, platform } = request.data;

    // Toggle first: if the account is gone, no device row gets minted at all.
    if (!(await setPushEnabled(true))) return notFound();

    // Upsert keeps re-registration (token refresh, reinstall) idempotent.
    await db.send(
      new PutCommand({
        TableName: table,
        Item: {
          ...deviceKey(sub, expoPushToken),
          ...deviceGsi(sub, expoPushToken),
          platform,
          updatedAt: new Date().toISOString(),
        },
      }),
    );
    return json(200, AckResponse.parse({ status: "ok" }));
  }

  if (path.endsWith("/push")) {
    const request = PushToggleRequest.safeParse(body);
    if (!request.success) return badRequest();
    if (!(await setPushEnabled(request.data.enabled))) return notFound();
    return json(200, AckResponse.parse({ status: "ok" }));
  }

  return notFound();
};
