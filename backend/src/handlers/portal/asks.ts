/**
 * Content Hub (portal API): staff post asks, athletes claim them, film and
 * send the files, and staff accept the work or send it back.
 *
 *   GET    /v1/asks                                  athletes: asks for them + any they claimed; staff: all + claims
 *   POST   /v1/asks                                  staff
 *   PUT    /v1/asks/{id}                             staff
 *   POST   /v1/asks/{id}/action                      claim, release (athletes) · submit (athletes) · decide, review (staff)
 *   POST   /v1/asks/{id}/uploads                     start or pick up an upload
 *   POST   /v1/asks/{id}/uploads/{fileId}/part       a short-lived link for one part
 *   POST   /v1/asks/{id}/uploads/{fileId}/complete   the file has landed
 *   DELETE /v1/asks/{id}/uploads/{fileId}            remove a file or stop an upload
 *   GET    /v1/asks/{id}/files/{sub}/{fileId}        a short-lived link to open a file
 *
 * Browsers send file parts straight to the submissions bucket, so large
 * uploads never pass through a Lambda. Nothing here reaches the public site.
 */
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  ListPartsCommand,
  type Part,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { BatchGetCommand, DeleteCommand, GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import {
  type Ask,
  AskActionRequest,
  AskUpsertRequest,
  AsksResponse,
  type ClaimStatus,
  FileUrlResponse,
  MAX_SUBMISSION_FILES,
  PortalAck,
  SubmissionFile,
  UploadPartRequest,
  UploadStartRequest,
  UploadStartResponse,
  isStaffRole,
  submissionParts,
  submissionTypeAllowed,
} from "@niltv/types";
import { ASKS_ALL_GSI1PK, GSI1, askClaimKey, askFileKey, askKey, getDocClient } from "../../lib/db";
import { type Caller, can, conflictResult, denied } from "../../lib/portal/access";
import { audienceIncludes, audienceLabel } from "../../lib/portal/audience";
import {
  CLAIM_FROM,
  StoredAsk,
  StoredClaim,
  StoredFile,
  canChangeFiles,
  fileKey,
  partsMatch,
  presentFile,
  readPartition,
  safeFileName,
} from "../../lib/portal/hub";
import { newPortalId } from "../../lib/portal/ids";
import { formerMember, getMembers, toPerson } from "../../lib/portal/members";
import { enqueue } from "../../lib/portal/notify";
import { badRequest, notFound, ok, portalHandler } from "../../lib/portal/router";

const table = (): string => process.env.TABLE_NAME ?? "";
const bucket = (): string => process.env.SUBMISSIONS_BUCKET ?? "";

/** Long enough for one 16 MB part on a slow phone connection. */
const PART_LINK_SECONDS = 60 * 60;
const OPEN_LINK_SECONDS = 15 * 60;

let s3: S3Client | undefined;
const getS3 = (): S3Client => (s3 ??= new S3Client({}));

const isCcf = (err: unknown): boolean => (err as { name?: string }).name === "ConditionalCheckFailedException";
const stale = () => conflictResult("CLAIM_MOVED", "This changed while you were looking. Refresh and try again.");

const askItem = (a: StoredAsk): Record<string, unknown> => ({
  ...askKey(a.id),
  GSI1PK: ASKS_ALL_GSI1PK,
  GSI1SK: `${a.createdAt}#${a.id}`,
  ...a,
});

const present = (a: StoredAsk): Ask => {
  const { createdBySub: _by, ...rest } = a;
  return rest;
};

async function getAsk(id: string): Promise<StoredAsk | undefined> {
  const out = await getDocClient().send(new GetCommand({ TableName: table(), Key: askKey(id) }));
  const parsed = StoredAsk.safeParse(out.Item ?? {});
  return parsed.success ? parsed.data : undefined;
}

async function listAsks(): Promise<StoredAsk[]> {
  const out = await getDocClient().send(
    new QueryCommand({
      TableName: table(),
      IndexName: GSI1,
      KeyConditionExpression: "GSI1PK = :pk",
      ExpressionAttributeValues: { ":pk": ASKS_ALL_GSI1PK },
      ScanIndexForward: false,
      Limit: 200,
    }),
  );
  return (out.Items ?? [])
    .map((item) => StoredAsk.safeParse(item))
    .filter((p): p is { success: true; data: StoredAsk } => p.success)
    .map((p) => p.data);
}

async function queryAll(values: Record<string, unknown>, condition: string): Promise<Record<string, unknown>[]> {
  const items: Record<string, unknown>[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const page = await getDocClient().send(
      new QueryCommand({
        TableName: table(),
        KeyConditionExpression: condition,
        ExpressionAttributeValues: values,
        ExclusiveStartKey: startKey,
      }),
    );
    items.push(...((page.Items ?? []) as Record<string, unknown>[]));
    startKey = page.LastEvaluatedKey;
  } while (startKey);
  return items;
}

const askPartition = (id: string) => queryAll({ ":pk": `ASK#${id}` }, "PK = :pk");

/** One person's file rows on an ask. */
async function filesOf(askId: string, sub: string): Promise<StoredFile[]> {
  const items = await queryAll({ ":pk": `ASK#${askId}`, ":f": `FILE#${sub}#` }, "PK = :pk AND begins_with(SK, :f)");
  return items.flatMap((item) => {
    const file = StoredFile.safeParse(item);
    return file.success ? [file.data] : [];
  });
}

async function getClaim(askId: string, sub: string): Promise<StoredClaim | undefined> {
  const out = await getDocClient().send(new GetCommand({ TableName: table(), Key: askClaimKey(askId, sub), ConsistentRead: true }));
  const parsed = StoredClaim.safeParse(out.Item ?? {});
  return parsed.success ? parsed.data : undefined;
}

async function getFile(askId: string, sub: string, fileId: string): Promise<StoredFile | undefined> {
  const out = await getDocClient().send(new GetCommand({ TableName: table(), Key: askFileKey(askId, sub, fileId), ConsistentRead: true }));
  const parsed = StoredFile.safeParse(out.Item ?? {});
  return parsed.success ? parsed.data : undefined;
}

/** Move a claim only if it is still where the caller saw it. False when it moved. */
async function moveClaim(
  askId: string,
  sub: string,
  from: readonly ClaimStatus[],
  to: ClaimStatus,
  fields: Record<string, unknown>,
): Promise<boolean> {
  const names = Object.keys(fields);
  const froms = Object.fromEntries(from.map((s, i) => [`:from${i}`, s]));
  try {
    await getDocClient().send(
      new UpdateCommand({
        TableName: table(),
        Key: askClaimKey(askId, sub),
        UpdateExpression: `SET #s = :to${names.map((n) => `, #${n} = :${n}`).join("")}`,
        ConditionExpression: `#s IN (${Object.keys(froms).join(", ")})`,
        ExpressionAttributeNames: { "#s": "status", ...Object.fromEntries(names.map((n) => [`#${n}`, n])) },
        ExpressionAttributeValues: {
          ":to": to,
          ...froms,
          ...Object.fromEntries(names.map((n) => [`:${n}`, fields[n]])),
        },
      }),
    );
    return true;
  } catch (err) {
    if (isCcf(err)) return false;
    throw err;
  }
}

/** Remove a file and whatever it left in the bucket. */
async function dropFile(askId: string, file: StoredFile): Promise<void> {
  if (file.uploadId) {
    await getS3()
      .send(new AbortMultipartUploadCommand({ Bucket: bucket(), Key: file.key, UploadId: file.uploadId }))
      .catch((err: unknown) => console.warn("asks: abort failed", (err as { name?: string }).name));
  } else {
    await getS3().send(new DeleteObjectCommand({ Bucket: bucket(), Key: file.key }));
  }
  await getDocClient().send(new DeleteCommand({ TableName: table(), Key: askFileKey(askId, file.sub, file.id) }));
}

async function uploadedParts(file: StoredFile): Promise<Part[]> {
  const parts: Part[] = [];
  let marker: string | undefined;
  do {
    const page = await getS3().send(
      new ListPartsCommand({ Bucket: bucket(), Key: file.key, UploadId: file.uploadId, PartNumberMarker: marker }),
    );
    parts.push(...(page.Parts ?? []));
    marker = page.IsTruncated ? page.NextPartNumberMarker : undefined;
  } while (marker);
  return parts;
}

/** The caller's claim, when they may still change its files. */
async function workingClaim(caller: Caller, askId: string): Promise<StoredClaim | undefined> {
  if (caller.member.role !== "athlete") return undefined;
  const claim = await getClaim(askId, caller.sub);
  return claim && canChangeFiles(claim.status) ? claim : undefined;
}

const claimFields = (claim: StoredClaim, files: readonly StoredFile[]) => ({
  status: claim.status,
  at: claim.at,
  note: claim.note,
  reviewNote: claim.reviewNote,
  files: files.map(presentFile),
});

export const handler = portalHandler({
  "GET /v1/asks": async ({ caller }) => {
    if (!can(caller, "viewHub")) return denied();
    const all = await listAsks();

    if (!isStaffRole(caller.member.role)) {
      const claims = new Map<string, StoredClaim>();
      for (let i = 0; i < all.length; i += 100) {
        const keys = all.slice(i, i + 100).map((a) => ({ ...askClaimKey(a.id, caller.sub) }));
        if (keys.length === 0) break;
        const res = await getDocClient().send(new BatchGetCommand({ RequestItems: { [table()]: { Keys: keys } } }));
        for (const item of res.Responses?.[table()] ?? []) {
          const claim = StoredClaim.safeParse(item);
          if (claim.success) claims.set(String(item["PK"]).slice("ASK#".length), claim.data);
        }
      }
      const visible = all.filter(
        (a) => claims.has(a.id) || (a.status === "open" && audienceIncludes(a.audience, caller.member, new Set())),
      );
      const asks = await Promise.all(
        visible.map(async (a) => {
          const claim = claims.get(a.id);
          if (!claim) return present(a);
          const files = (await filesOf(a.id, caller.sub)).filter((f) => f.state === "ready");
          return { ...present(a), myClaim: claimFields(claim, files) };
        }),
      );
      return ok(AsksResponse.parse({ asks }));
    }

    const partitions = await Promise.all(all.map(async (a) => readPartition(await askPartition(a.id))));
    const people = await getMembers(partitions.flatMap((p) => p.claims.map((c) => c.sub)));
    const asks = all.map((a, i) => {
      const { claims, files } = partitions[i]!;
      return {
        ...present(a),
        claims: claims.map((c) => {
          const m = people.get(c.sub);
          return {
            ...claimFields(c, files.get(c.sub) ?? []),
            person: m ? toPerson(m) : formerMember(c.sub),
            ...(m ? { email: m.email } : {}),
          };
        }),
      };
    });
    return ok(AsksResponse.parse({ asks }));
  },

  "POST /v1/asks": async ({ caller, body }) => {
    if (!can(caller, "manageHub")) return denied();
    const req = body(AskUpsertRequest);
    if (!req) return badRequest();
    const ask: StoredAsk = {
      id: newPortalId("ask"),
      ...req,
      audienceLabel: await audienceLabel(req.audience),
      createdBySub: caller.sub,
      createdByName: caller.member.name,
      createdAt: new Date().toISOString(),
    };
    await getDocClient().send(new PutCommand({ TableName: table(), Item: askItem(ask) }));
    if (ask.status === "open") await enqueue({ type: "ask.new", askId: ask.id });
    return ok(present(ask), 201);
  },

  "PUT /v1/asks/{id}": async ({ caller, body, param }) => {
    if (!can(caller, "manageHub")) return denied();
    const req = body(AskUpsertRequest);
    if (!req) return badRequest();
    const current = await getAsk(param("id"));
    if (!current) return notFound();
    const ask: StoredAsk = {
      ...current,
      ...req,
      audienceLabel: await audienceLabel(req.audience),
      updatedAt: new Date().toISOString(),
    };
    await getDocClient().send(new PutCommand({ TableName: table(), Item: askItem(ask) }));
    return ok(present(ask));
  },

  "POST /v1/asks/{id}/action": async ({ caller, body, param }) => {
    if (!can(caller, "viewHub")) return denied();
    const req = body(AskActionRequest);
    if (!req) return badRequest();
    const ask = await getAsk(param("id"));
    if (!ask) return notFound();
    const done = () => ok(PortalAck.parse({ status: "ok" }));
    const now = new Date().toISOString();

    if (req.action === "claim") {
      if (caller.member.role !== "athlete") return denied();
      if (ask.status !== "open") return badRequest("This ask is closed.");
      if (!audienceIncludes(ask.audience, caller.member, new Set())) return denied();
      const status: ClaimStatus = ask.requiresApproval ? "requested" : "claimed";
      try {
        await getDocClient().send(
          new PutCommand({
            TableName: table(),
            Item: { ...askClaimKey(ask.id, caller.sub), sub: caller.sub, status, at: now, note: "", reviewNote: "" },
            ConditionExpression: "attribute_not_exists(PK)",
          }),
        );
      } catch (err) {
        if (isCcf(err)) return done();
        throw err;
      }
      if (ask.requiresApproval) await enqueue({ type: "ask.claim", askId: ask.id, personSub: caller.sub });
      return done();
    }

    if (req.action === "release") {
      if (caller.member.role !== "athlete") return denied();
      try {
        await getDocClient().send(
          new DeleteCommand({
            TableName: table(),
            Key: askClaimKey(ask.id, caller.sub),
            ConditionExpression: "#s IN (:a, :b, :c)",
            ExpressionAttributeNames: { "#s": "status" },
            ExpressionAttributeValues: { ":a": CLAIM_FROM.release[0], ":b": CLAIM_FROM.release[1], ":c": CLAIM_FROM.release[2] },
          }),
        );
      } catch (err) {
        if (isCcf(err)) return stale();
        throw err;
      }
      await Promise.all((await filesOf(ask.id, caller.sub)).map((f) => dropFile(ask.id, f)));
      return done();
    }

    if (req.action === "submit") {
      if (caller.member.role !== "athlete") return denied();
      const files = (await filesOf(ask.id, caller.sub)).filter((f) => f.state === "ready");
      if (files.length === 0) return badRequest("Add at least one file first.");
      const moved = await moveClaim(ask.id, caller.sub, CLAIM_FROM.submit, "submitted", { note: req.note, submittedAt: now, reviewNote: "" });
      if (!moved) return stale();
      await enqueue({ type: "ask.submitted", askId: ask.id, personSub: caller.sub });
      return done();
    }

    if (!can(caller, "manageHub")) return denied();

    if (req.action === "decide") {
      const moved = await moveClaim(
        ask.id,
        req.personSub,
        req.approved ? CLAIM_FROM.approve : CLAIM_FROM.decline,
        req.approved ? "claimed" : "declined",
        { decidedAt: now, decidedBy: caller.sub },
      );
      if (!moved) return stale();
      await enqueue({ type: "ask.decision", askId: ask.id, personSub: req.personSub });
      return done();
    }

    if (req.outcome === "changes" && !req.note) return badRequest("Say what needs to change.");
    const moved = await moveClaim(ask.id, req.personSub, CLAIM_FROM.review, req.outcome, {
      reviewNote: req.outcome === "changes" ? req.note : "",
      decidedAt: now,
      decidedBy: caller.sub,
    });
    if (!moved) return stale();
    await enqueue({ type: "ask.decision", askId: ask.id, personSub: req.personSub });
    return done();
  },

  "POST /v1/asks/{id}/uploads": async ({ caller, body, param }) => {
    const req = body(UploadStartRequest);
    if (!req) return badRequest("Files can be up to 2 GB.");
    if (!submissionTypeAllowed(req.type)) return badRequest("Send a video, audio file or photo.");
    const askId = param("id");
    if (!(await workingClaim(caller, askId))) return denied();

    const existing = await filesOf(askId, caller.sub);
    // The same file picked again carries on where it stopped.
    const open = existing.find((f) => f.state === "uploading" && f.name === req.name && f.size === req.size);
    if (open) {
      try {
        const parts = await uploadedParts(open);
        return ok(UploadStartResponse.parse({ fileId: open.id, doneParts: parts.map((p) => p.PartNumber ?? 0).filter(Boolean) }));
      } catch (err) {
        if ((err as { name?: string }).name !== "NoSuchUpload") throw err;
        await getDocClient().send(new DeleteCommand({ TableName: table(), Key: askFileKey(askId, open.sub, open.id) }));
      }
    }
    // Landed files only: an upload someone walked away from must not lock them out.
    if (existing.filter((f) => f.state === "ready").length >= MAX_SUBMISSION_FILES) {
      return badRequest(`You can send up to ${MAX_SUBMISSION_FILES} files.`);
    }

    const id = newPortalId("file");
    const key = fileKey(askId, caller.sub, id, req.name);
    const created = await getS3().send(new CreateMultipartUploadCommand({ Bucket: bucket(), Key: key, ContentType: req.type }));
    const file: StoredFile = {
      sub: caller.sub,
      id,
      name: req.name,
      size: req.size,
      type: req.type,
      key,
      uploadId: created.UploadId,
      state: "uploading",
      at: new Date().toISOString(),
    };
    await getDocClient().send(new PutCommand({ TableName: table(), Item: { ...askFileKey(askId, caller.sub, id), ...file } }));
    return ok(UploadStartResponse.parse({ fileId: id, doneParts: [] }), 201);
  },

  "POST /v1/asks/{id}/uploads/{fileId}/part": async ({ caller, body, param }) => {
    const req = body(UploadPartRequest);
    if (!req) return badRequest();
    const askId = param("id");
    if (!(await workingClaim(caller, askId))) return denied();
    const file = await getFile(askId, caller.sub, param("fileId"));
    if (!file || file.state !== "uploading") return notFound();
    if (req.partNumber > submissionParts(file.size)) return badRequest();
    const url = await getSignedUrl(
      getS3(),
      new UploadPartCommand({ Bucket: bucket(), Key: file.key, UploadId: file.uploadId, PartNumber: req.partNumber }),
      { expiresIn: PART_LINK_SECONDS },
    );
    return ok(FileUrlResponse.parse({ url }));
  },

  "POST /v1/asks/{id}/uploads/{fileId}/complete": async ({ caller, param }) => {
    const askId = param("id");
    if (!(await workingClaim(caller, askId))) return denied();
    const file = await getFile(askId, caller.sub, param("fileId"));
    if (!file) return notFound();
    if (file.state === "ready") return ok(SubmissionFile.parse(presentFile(file)));

    // The bucket's list is the truth: a browser cannot claim parts it never sent.
    const parts = await uploadedParts(file);
    if (!partsMatch(parts.map((p) => ({ size: p.Size ?? 0 })), submissionParts(file.size), file.size)) {
      return badRequest("Part of this file did not arrive. Try it again.");
    }
    await getS3().send(
      new CompleteMultipartUploadCommand({
        Bucket: bucket(),
        Key: file.key,
        UploadId: file.uploadId,
        MultipartUpload: { Parts: parts.map((p) => ({ PartNumber: p.PartNumber, ETag: p.ETag })) },
      }),
    );
    const at = new Date().toISOString();
    await getDocClient().send(
      new UpdateCommand({
        TableName: table(),
        Key: askFileKey(askId, caller.sub, file.id),
        UpdateExpression: "SET #st = :ready, #at = :at REMOVE uploadId",
        ExpressionAttributeNames: { "#st": "state", "#at": "at" },
        ExpressionAttributeValues: { ":ready": "ready", ":at": at },
      }),
    );
    return ok(SubmissionFile.parse(presentFile({ ...file, state: "ready", at })));
  },

  "DELETE /v1/asks/{id}/uploads/{fileId}": async ({ caller, param }) => {
    const askId = param("id");
    if (!(await workingClaim(caller, askId))) return denied();
    const file = await getFile(askId, caller.sub, param("fileId"));
    if (file) await dropFile(askId, file);
    return ok(PortalAck.parse({ status: "ok" }));
  },

  "GET /v1/asks/{id}/files/{sub}/{fileId}": async ({ caller, param }) => {
    const sub = param("sub");
    if (!can(caller, "manageHub") && !(caller.member.role === "athlete" && caller.sub === sub)) return denied();
    const file = await getFile(param("id"), sub, param("fileId"));
    if (!file || file.state !== "ready") return notFound();
    const url = await getSignedUrl(
      getS3(),
      new GetObjectCommand({
        Bucket: bucket(),
        Key: file.key,
        ResponseContentType: file.type,
        ResponseContentDisposition: `inline; filename="${safeFileName(file.name)}"`,
      }),
      { expiresIn: OPEN_LINK_SECONDS },
    );
    return ok(FileUrlResponse.parse({ url }));
  },
});
