/**
 * Origin lockdown (design §8, §10): CloudFront injects the shared secret as
 * the x-origin-verify header on every origin request. Handlers call
 * `requireOriginVerify` and 403 when the header is missing or wrong, so
 * hitting the execute-api endpoint directly can't bypass CloudFront/WAF.
 */
import type { APIGatewayProxyEventV2 } from "aws-lambda";

/**
 * True when the request carries the correct x-origin-verify header. When
 * ORIGIN_VERIFY_SECRET is unset (unit tests / local dev), the check passes.
 */
export function requireOriginVerify(event: APIGatewayProxyEventV2): boolean {
  const secret = process.env.ORIGIN_VERIFY_SECRET;
  if (!secret) {
    return true;
  }
  // HTTP API lowercases header names before invoking the integration.
  return event.headers?.["x-origin-verify"] === secret;
}
