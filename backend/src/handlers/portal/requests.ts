/**
 * Page change requests and Help (portal API):
 *
 *   GET   /v1/requests          athletes: their own; staff: the whole queue
 *   POST  /v1/requests          athletes: ask for a change to their athlete page
 *   PATCH /v1/requests/{id}     staff: mark done or declined, with a note
 *   POST  /v1/help              anyone: emails the support address, reply-to the sender
 */
import { GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import {
  HelpRequest,
  type PortalRequest,
  PortalRequestCreate,
  PortalRequestStatus,
  PortalRequestUpdate,
  PortalRequestsResponse,
  PortalRole,
  isStaffRole,
} from "@niltv/types";
import { z } from "zod";
import { GSI1, PORTAL_REQUESTS_GSI1PK, getDocClient, portalRequestKey } from "../../lib/db";
import { can, denied } from "../../lib/portal/access";
import { newPortalId } from "../../lib/portal/ids";
import { enqueue } from "../../lib/portal/notify";
import { badRequest, notFound, ok, portalHandler } from "../../lib/portal/router";

const table = (): string => process.env.TABLE_NAME ?? "";

const StoredRequest = z.object({
  id: z.string(),
  kind: z.literal("page_change"),
  body: z.string(),
  link: z.string().optional(),
  status: PortalRequestStatus,
  personSub: z.string(),
  personName: z.string(),
  personRole: PortalRole,
  createdAt: z.string(),
  staffNote: z.string().optional(),
  resolvedAt: z.string().optional(),
  resolvedByName: z.string().optional(),
});
type StoredRequest = z.infer<typeof StoredRequest>;

const requestItem = (r: StoredRequest): Record<string, unknown> => ({
  ...portalRequestKey(r.id),
  GSI1PK: PORTAL_REQUESTS_GSI1PK,
  GSI1SK: `${r.createdAt}#${r.id}`,
  ...r,
});

function present(r: StoredRequest): PortalRequest {
  const { personSub, personName, personRole, ...rest } = r;
  return { ...rest, person: { sub: personSub, name: personName, role: personRole } };
}

export const handler = portalHandler({
  "GET /v1/requests": async ({ caller }) => {
    const staff = isStaffRole(caller.member.role);
    if (!staff && !can(caller, "requestPageChange")) return denied();
    const out = await getDocClient().send(
      new QueryCommand({
        TableName: table(),
        IndexName: GSI1,
        KeyConditionExpression: "GSI1PK = :pk",
        ExpressionAttributeValues: { ":pk": PORTAL_REQUESTS_GSI1PK },
        ScanIndexForward: false,
        Limit: 300,
      }),
    );
    const rows = (out.Items ?? [])
      .map((item) => StoredRequest.safeParse(item))
      .filter((p): p is { success: true; data: StoredRequest } => p.success)
      .map((p) => p.data)
      .filter((r) => staff || r.personSub === caller.sub);
    return ok(PortalRequestsResponse.parse({ requests: rows.map(present) }));
  },

  "POST /v1/requests": async ({ caller, body }) => {
    if (!can(caller, "requestPageChange")) return denied();
    const req = body(PortalRequestCreate);
    if (!req) return badRequest();
    const row: StoredRequest = {
      id: newPortalId("req"),
      kind: "page_change",
      body: req.body,
      ...(req.link ? { link: req.link } : {}),
      status: "open",
      personSub: caller.sub,
      personName: caller.member.name,
      personRole: caller.member.role,
      createdAt: new Date().toISOString(),
    };
    await getDocClient().send(new PutCommand({ TableName: table(), Item: requestItem(row) }));
    await enqueue({ type: "request.new", requestId: row.id });
    return ok(present(row), 201);
  },

  "PATCH /v1/requests/{id}": async ({ caller, body, param }) => {
    if (!can(caller, "manageRequests")) return denied();
    const req = body(PortalRequestUpdate);
    if (!req) return badRequest();
    const out = await getDocClient().send(new GetCommand({ TableName: table(), Key: portalRequestKey(param("id")) }));
    const current = StoredRequest.safeParse(out.Item ?? {});
    if (!current.success) return notFound();
    const resolved = req.status !== "open";
    const row: StoredRequest = {
      ...current.data,
      status: req.status,
      ...(req.staffNote !== undefined ? { staffNote: req.staffNote } : {}),
      ...(resolved ? { resolvedAt: new Date().toISOString(), resolvedByName: caller.member.name } : {}),
    };
    if (!resolved) {
      delete row.resolvedAt;
      delete row.resolvedByName;
    }
    await getDocClient().send(new PutCommand({ TableName: table(), Item: requestItem(row) }));
    return ok(present(row));
  },

  "POST /v1/help": async ({ caller, body }) => {
    const req = body(HelpRequest);
    if (!req) return badRequest();
    await enqueue({ type: "help", sub: caller.sub, topic: req.topic, message: req.message });
    return ok({ status: "ok" }, 202);
  },
});
