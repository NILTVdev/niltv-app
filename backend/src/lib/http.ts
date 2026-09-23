/**
 * Response helpers shared by the HTTP API handlers: one JSON envelope plus
 * the standard error bodies (ApiError shape from @niltv/types). Cache-Control
 * is opt-in per response — public GETs pass their CloudFront TTL (design §8),
 * private reads pass "private, no-store", writes pass nothing.
 */
import { ApiError } from "@niltv/types";
import type { APIGatewayProxyStructuredResultV2 } from "aws-lambda";

/** JSON response; pass a Cache-Control value for CloudFront-cacheable GETs. */
export function json(
  statusCode: number,
  body: unknown,
  cacheControl?: string,
): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode,
    headers: {
      "content-type": "application/json",
      ...(cacheControl ? { "cache-control": cacheControl } : {}),
    },
    body: JSON.stringify(body),
  };
}

/** 403 FORBIDDEN — the origin-lockdown rejection (same body as /v1/config). */
export const forbidden = (): APIGatewayProxyStructuredResultV2 =>
  json(403, ApiError.parse({ error: "FORBIDDEN" }));

/** 401 UNAUTHORIZED — no usable JWT subject on an authed route. */
export const unauthorized = (): APIGatewayProxyStructuredResultV2 =>
  json(401, ApiError.parse({ error: "UNAUTHORIZED" }));

/** 404 NOT_FOUND. */
export const notFound = (): APIGatewayProxyStructuredResultV2 =>
  json(404, ApiError.parse({ error: "NOT_FOUND" }));

/** 400 INVALID_REQUEST — malformed JSON or a zod-rejected body. */
export const badRequest = (message?: string): APIGatewayProxyStructuredResultV2 =>
  json(400, ApiError.parse({ error: "INVALID_REQUEST", ...(message ? { message } : {}) }));

/** JSON request body, base64-aware; undefined for absent/unparseable (caller 400s via zod). */
export function parseJsonBody(body: string | undefined, isBase64Encoded: boolean): unknown {
  if (body === undefined || body === "") return undefined;
  const raw = isBase64Encoded ? Buffer.from(body, "base64").toString("utf8") : body;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}
