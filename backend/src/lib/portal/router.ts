/**
 * Shared entry for the portal Lambdas: authorize the caller (an active
 * portal member, see access.ts), then dispatch on the HTTP API route key
 * ("GET /v1/inbox"). A handler file is just its route table.
 */
import { ApiError } from "@niltv/types";
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyHandlerV2WithJWTAuthorizer } from "aws-lambda";
import type { z } from "zod";
import { badRequest, json, notFound, parseJsonBody } from "../http";
import { type Caller, type Result, authorize } from "./access";
import { ROUTE_LIMITS, rateLimitedMessage, secondsLeft, takeWrite } from "./limits";

export interface RouteContext {
  event: APIGatewayProxyEventV2WithJWTAuthorizer;
  caller: Caller;
  /** a path parameter, or "" */
  param: (name: string) => string;
  /** a query string value, or undefined */
  query: (name: string) => string | undefined;
  /** the JSON body parsed with a contract schema; undefined when invalid */
  body: <T extends z.ZodTypeAny>(schema: T) => z.infer<T> | undefined;
  /** the 400 for a body that failed `schema`, carrying a refinement's own message (a refused name) */
  rejectBody: (schema: z.ZodTypeAny) => Result;
}

export type Route = (ctx: RouteContext) => Promise<Result>;

export const PRIVATE = "private, no-store";

export const ok = (body: unknown, status = 200): Result => json(status, body, PRIVATE);

export { badRequest, notFound };

export function portalHandler(routes: Record<string, Route>): APIGatewayProxyHandlerV2WithJWTAuthorizer {
  return async (event) => {
    const auth = await authorize(event);
    if ("response" in auth) return auth.response;
    const route = routes[event.routeKey];
    if (!route) return notFound();
    const limit = ROUTE_LIMITS[event.routeKey];
    if (limit) {
      try {
        const now = Date.now();
        if (!(await takeWrite(auth.caller.sub, limit, now))) {
          return json(
            429,
            ApiError.parse({ error: "RATE_LIMITED", message: rateLimitedMessage(limit), retryAfterSec: secondsLeft(limit, now) }),
          );
        }
      } catch (err) {
        // A counter that cannot be read must not block real work.
        console.warn(`portal: write limit check failed for ${event.routeKey}`, err);
      }
    }
    const ctx: RouteContext = {
      event,
      caller: auth.caller,
      param: (name) => event.pathParameters?.[name] ?? "",
      query: (name) => event.queryStringParameters?.[name],
      body: (schema) => {
        const parsed = schema.safeParse(parseJsonBody(event.body, event.isBase64Encoded === true));
        return parsed.success ? parsed.data : undefined;
      },
      rejectBody: (schema) => {
        const parsed = schema.safeParse(parseJsonBody(event.body, event.isBase64Encoded === true));
        const custom = parsed.success ? undefined : parsed.error.issues.find((issue) => issue.code === "custom");
        return badRequest(custom?.message);
      },
    };
    try {
      return await route(ctx);
    } catch (err) {
      console.error(`portal: ${event.routeKey} failed`, err);
      return json(500, ApiError.parse({ error: "INTERNAL", message: "Something went wrong. Try again." }));
    }
  };
}
