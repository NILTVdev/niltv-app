/**
 * Who is calling, and may they? Two layers, both fail closed:
 *
 *   1. The HTTP API's JWT authorizer proves a valid niltv.com sign-in.
 *      Any site account passes it.
 *   2. Here: the caller's USER#{sub} / PORTAL row must exist and be active,
 *      and its role must allow the action (PORTAL_PERMISSIONS in
 *      @niltv/types, the same table the client menu reads).
 *
 * The role comes from the row, never from a token claim, so a role change
 * or removal applies on the very next request.
 */
import { ApiError, type PortalMember, type PortalPermission, portalCan } from "@niltv/types";
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { json, unauthorized } from "../http";
import { getMember, touchSeen } from "./members";

export type Result = APIGatewayProxyStructuredResultV2;

export interface Caller {
  sub: string;
  member: PortalMember;
}

/** 403 with a portal error code. */
export const denied = (error: "NOT_MEMBER" | "FORBIDDEN" | "STAFF_ONLY" = "FORBIDDEN", message?: string): Result =>
  json(403, ApiError.parse({ error, ...(message ? { message } : {}) }));

export const conflictResult = (error: string, message: string): Result =>
  json(409, ApiError.parse({ error, message }));

/** The JWT subject, or undefined when the claim is absent or not a string. */
export function subOf(event: APIGatewayProxyEventV2WithJWTAuthorizer): string | undefined {
  const sub = event.requestContext?.authorizer?.jwt?.claims?.["sub"];
  return typeof sub === "string" && sub.length > 0 ? sub : undefined;
}

/** Resolve the caller to an active member, or the response that refuses them. */
export async function authorize(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<{ caller: Caller } | { response: Result }> {
  const sub = subOf(event);
  if (!sub) return { response: unauthorized() };
  const member = await getMember(sub);
  if (!member || member.status !== "active") {
    return { response: denied("NOT_MEMBER", "This account does not have portal access yet.") };
  }
  // Any request means the portal is open: that cancels pending summaries
  // and holds back pushes (lib/portal/prefs.ts).
  return { caller: { sub, member: await touchSeen(member) } };
}

export const can = (caller: Caller, permission: PortalPermission): boolean => portalCan(caller.member.role, permission);
