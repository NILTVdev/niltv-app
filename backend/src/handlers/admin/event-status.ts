/**
 * POST /admin/events/{id}/status (staff) — the break-glass manual override
 * (design §6.5): same transition code path as the scheduled
 * one-shots, but `force` — it may move backwards (ended → live to reopen a
 * mis-closed window). NOTE: reopening does not resurrect consumed one-shots;
 * re-save the event (dates) to re-create them, or close it manually again.
 */
import { AdminEventStatusRequest } from "@niltv/types";
import type { APIGatewayProxyHandlerV2WithJWTAuthorizer } from "aws-lambda";
import { transitionEvent } from "../event-transition";
import { forbidden, json, notFound } from "../../lib/http";
import { requireStaff } from "./authz";
import { badRequest, parseJsonBody } from "./util";

export const handler: APIGatewayProxyHandlerV2WithJWTAuthorizer = async (event) => {
  if (!requireStaff(event)) return forbidden();

  const eventId = event.pathParameters?.["id"];
  if (!eventId) return notFound();

  const body = parseJsonBody(event);
  if (body === undefined) return badRequest("request body is not valid JSON");
  const parsed = AdminEventStatusRequest.safeParse(body);
  if (!parsed.success) return badRequest(parsed.error.issues.map((i) => i.message).join("; "));

  const result = await transitionEvent(eventId, parsed.data.status, true);
  if (result === "not-found") return notFound();
  return json(200, { status: "ok", transition: result });
};
