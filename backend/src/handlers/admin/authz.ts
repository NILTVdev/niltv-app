/**
 * Staff authorization for the admin API (design §4 access tiers: admin =
 * Cognito JWT + `staff` group). The HTTP API's JWT authorizer only proves the
 * caller holds a valid pool token — ANY signed-in fan passes it — so every
 * admin handler must additionally check group membership here. Fail closed:
 * a missing/undecipherable claim is a deny, never a default-allow
 * (conventions §Auth & claims).
 */
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from "aws-lambda";

const STAFF_GROUP = "staff";

/**
 * True only when the verified JWT's `cognito:groups` claim contains `staff`.
 *
 * The claim reaches the handler in one of three shapes depending on the
 * authorizer/runtime path, and all three must be handled:
 *   1. a real array: ["staff", ...]
 *   2. a plain string: "staff" (single-group tokens)
 *   3. a stringified array: "[staff]" / "[staff admins]" — API Gateway's HTTP
 *      API JWT authorizer flattens array claims into this bracketed form.
 */
export function requireStaff(event: APIGatewayProxyEventV2WithJWTAuthorizer): boolean {
  const claim = event.requestContext?.authorizer?.jwt?.claims?.["cognito:groups"];

  if (Array.isArray(claim)) {
    return claim.some((group) => group === STAFF_GROUP);
  }
  if (typeof claim !== "string" || claim.length === 0) {
    return false; // absent, empty, or a non-string surprise → deny
  }

  // Bracketed stringified-array form → strip the brackets; then split either
  // form on separators. Exact-match against the split parts so a group named
  // e.g. "staffing" can never sneak past a substring check.
  const inner =
    claim.startsWith("[") && claim.endsWith("]") ? claim.slice(1, -1) : claim;
  return inner
    .split(/[\s,]+/)
    .some((group) => group === STAFF_GROUP);
}
