/**
 * Internal Postings (portal API): staff post jobs, internships and other
 * openings; athletes mark interest. With "requires approval" on, staff are
 * emailed for each interested athlete and approve or decline them; with it
 * off, interest is only a list on the posting.
 *
 *   GET  /v1/postings                  athletes: open ones (+ any they joined); staff: all + interest
 *   POST /v1/postings                  staff
 *   PUT  /v1/postings/{id}             staff
 *   POST /v1/postings/{id}/action      interest (athletes) · decide (staff)
 */
import { BatchGetCommand, DeleteCommand, GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import {
  InterestStatus,
  PortalAck,
  type Posting,
  PostingActionRequest,
  PostingUpsertRequest,
  PostingsResponse,
  isStaffRole,
} from "@niltv/types";
import { z } from "zod";
import { GSI1, POSTINGS_ALL_GSI1PK, getDocClient, postingInterestKey, postingKey } from "../../lib/db";
import { can, denied } from "../../lib/portal/access";
import { newPortalId } from "../../lib/portal/ids";
import { formerMember, getMembers, toPerson } from "../../lib/portal/members";
import { enqueue } from "../../lib/portal/notify";
import { badRequest, notFound, ok, portalHandler } from "../../lib/portal/router";

const table = (): string => process.env.TABLE_NAME ?? "";

const StoredPosting = z.object({
  id: z.string(),
  title: z.string(),
  about: z.string().default(""),
  details: z.string().default(""),
  requiresApproval: z.boolean().default(false),
  status: z.enum(["open", "closed"]),
  createdBySub: z.string(),
  createdByName: z.string(),
  createdAt: z.string(),
  updatedAt: z.string().optional(),
  interestCount: z.number().int().default(0),
});
type StoredPosting = z.infer<typeof StoredPosting>;

const postingItem = (p: StoredPosting): Record<string, unknown> => ({
  ...postingKey(p.id),
  GSI1PK: POSTINGS_ALL_GSI1PK,
  GSI1SK: `${p.createdAt}#${p.id}`,
  ...p,
});

async function getPosting(id: string): Promise<StoredPosting | undefined> {
  const out = await getDocClient().send(new GetCommand({ TableName: table(), Key: postingKey(id) }));
  const parsed = StoredPosting.safeParse(out.Item ?? {});
  return parsed.success ? parsed.data : undefined;
}

async function listPostings(): Promise<StoredPosting[]> {
  const out = await getDocClient().send(
    new QueryCommand({
      TableName: table(),
      IndexName: GSI1,
      KeyConditionExpression: "GSI1PK = :pk",
      ExpressionAttributeValues: { ":pk": POSTINGS_ALL_GSI1PK },
      ScanIndexForward: false,
      Limit: 200,
    }),
  );
  return (out.Items ?? [])
    .map((item) => StoredPosting.safeParse(item))
    .filter((p): p is { success: true; data: StoredPosting } => p.success)
    .map((p) => p.data);
}

const InterestRow = z.object({ sub: z.string(), status: InterestStatus, at: z.string() });

async function interestFor(id: string): Promise<z.infer<typeof InterestRow>[]> {
  const out = await getDocClient().send(
    new QueryCommand({
      TableName: table(),
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :i)",
      ExpressionAttributeValues: { ":pk": `POSTING#${id}`, ":i": "INTEREST#" },
    }),
  );
  return (out.Items ?? [])
    .map((item) => InterestRow.safeParse(item))
    .filter((p): p is { success: true; data: z.infer<typeof InterestRow> } => p.success)
    .map((p) => p.data);
}

const present = (p: StoredPosting): Posting => {
  const { createdBySub: _by, ...rest } = p;
  return rest;
};

/**
 * True the first time this athlete shows interest in this posting. Staff get
 * one interest email per athlete per posting, so withdrawing and showing
 * interest again cannot flood their inbox. The marker sits next to the
 * interest rows: POSTING#{id} / NOTIFIED#{sub}.
 */
async function firstInterest(postingId: string, sub: string, at: string): Promise<boolean> {
  try {
    await getDocClient().send(
      new PutCommand({
        TableName: table(),
        Item: { PK: `POSTING#${postingId}`, SK: `NOTIFIED#${sub}`, at },
        ConditionExpression: "attribute_not_exists(PK)",
      }),
    );
    return true;
  } catch (err) {
    if ((err as { name?: string }).name === "ConditionalCheckFailedException") return false;
    throw err;
  }
}

export const handler = portalHandler({
  "GET /v1/postings": async ({ caller }) => {
    if (!can(caller, "viewPostings")) return denied();
    const all = await listPostings();

    if (!isStaffRole(caller.member.role)) {
      // My interest on each posting, one BatchGet per 100.
      const mine = new Map<string, InterestStatus>();
      for (let i = 0; i < all.length; i += 100) {
        const keys = all.slice(i, i + 100).map((p) => ({ ...postingInterestKey(p.id, caller.sub) }));
        if (keys.length === 0) break;
        const res = await getDocClient().send(new BatchGetCommand({ RequestItems: { [table()]: { Keys: keys } } }));
        for (const item of res.Responses?.[table()] ?? []) {
          const status = InterestStatus.safeParse(item["status"]);
          if (status.success) mine.set(String(item["PK"]).slice("POSTING#".length), status.data);
        }
      }
      const postings = all
        .filter((p) => p.status === "open" || mine.has(p.id))
        .map((p) => ({ ...present(p), ...(mine.has(p.id) ? { myInterest: mine.get(p.id) } : {}) }));
      return ok(PostingsResponse.parse({ postings }));
    }

    const interest = await Promise.all(all.map((p) => interestFor(p.id)));
    const people = await getMembers(interest.flat().map((r) => r.sub));
    const postings = all.map((p, i) => ({
      ...present(p),
      interest: interest[i]!.map((r) => {
        const m = people.get(r.sub);
        return { person: m ? toPerson(m) : formerMember(r.sub), ...(m ? { email: m.email } : {}), status: r.status, at: r.at };
      }),
    }));
    return ok(PostingsResponse.parse({ postings }));
  },

  "POST /v1/postings": async ({ caller, body }) => {
    if (!can(caller, "managePostings")) return denied();
    const req = body(PostingUpsertRequest);
    if (!req) return badRequest();
    const posting: StoredPosting = {
      id: newPortalId("post"),
      ...req,
      createdBySub: caller.sub,
      createdByName: caller.member.name,
      createdAt: new Date().toISOString(),
      interestCount: 0,
    };
    await getDocClient().send(new PutCommand({ TableName: table(), Item: postingItem(posting) }));
    if (posting.status === "open") await enqueue({ type: "posting.new", postingId: posting.id });
    return ok(present(posting), 201);
  },

  "PUT /v1/postings/{id}": async ({ caller, body, param }) => {
    if (!can(caller, "managePostings")) return denied();
    const req = body(PostingUpsertRequest);
    if (!req) return badRequest();
    const current = await getPosting(param("id"));
    if (!current) return notFound();
    const posting: StoredPosting = { ...current, ...req, updatedAt: new Date().toISOString() };
    await getDocClient().send(new PutCommand({ TableName: table(), Item: postingItem(posting) }));
    return ok(present(posting));
  },

  "POST /v1/postings/{id}/action": async ({ caller, body, param }) => {
    const req = body(PostingActionRequest);
    if (!req) return badRequest();
    const posting = await getPosting(param("id"));
    if (!posting) return notFound();
    const db = getDocClient();
    const now = new Date().toISOString();

    if (req.action === "interest") {
      if (caller.member.role !== "athlete") return denied();
      if (req.interested) {
        if (posting.status !== "open") return badRequest("This posting is closed.");
        try {
          await db.send(
            new PutCommand({
              TableName: table(),
              Item: { ...postingInterestKey(posting.id, caller.sub), sub: caller.sub, status: "interested", at: now },
              ConditionExpression: "attribute_not_exists(PK)",
            }),
          );
        } catch (err) {
          if ((err as { name?: string }).name === "ConditionalCheckFailedException") return ok(PortalAck.parse({ status: "ok" }));
          throw err;
        }
        await db.send(
          new UpdateCommand({
            TableName: table(),
            Key: postingKey(posting.id),
            UpdateExpression: "ADD interestCount :one",
            ExpressionAttributeValues: { ":one": 1 },
          }),
        );
        if (posting.requiresApproval && (await firstInterest(posting.id, caller.sub, now))) {
          await enqueue({ type: "posting.interest", postingId: posting.id, personSub: caller.sub });
        }
        return ok(PortalAck.parse({ status: "ok" }));
      }
      const removed = await db.send(
        new DeleteCommand({ TableName: table(), Key: postingInterestKey(posting.id, caller.sub), ReturnValues: "ALL_OLD" }),
      );
      if (removed.Attributes) {
        await db.send(
          new UpdateCommand({
            TableName: table(),
            Key: postingKey(posting.id),
            UpdateExpression: "ADD interestCount :minus",
            ExpressionAttributeValues: { ":minus": -1 },
          }),
        );
      }
      return ok(PortalAck.parse({ status: "ok" }));
    }

    if (!can(caller, "managePostings")) return denied();
    if (!posting.requiresApproval) return badRequest("This posting does not need approval.");
    try {
      await db.send(
        new UpdateCommand({
          TableName: table(),
          Key: postingInterestKey(posting.id, req.personSub),
          UpdateExpression: "SET #s = :s, decidedAt = :now, decidedBy = :by",
          ConditionExpression: "attribute_exists(PK)",
          ExpressionAttributeNames: { "#s": "status" },
          ExpressionAttributeValues: { ":s": req.status, ":now": now, ":by": caller.sub },
        }),
      );
    } catch (err) {
      if ((err as { name?: string }).name === "ConditionalCheckFailedException") return notFound();
      throw err;
    }
    await enqueue({ type: "posting.decision", postingId: posting.id, personSub: req.personSub });
    return ok(PortalAck.parse({ status: "ok" }));
  },
});
