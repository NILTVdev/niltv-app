/**
 * Account deletion, Content Hub part: a member's claims, file rows and the
 * files themselves. Called from DELETE /v1/me (handlers/delete-me.ts) before
 * the Cognito user goes, so a failed run can be retried with the same token.
 *
 * Hub rows live in each ask's partition (ASK#{id}), not in USER#{sub}, so
 * this walks every ask. Cost per deletion: the ASKS#ALL index pages, then
 * for each ask one S3 list, one query and one delete for the claim, plus
 * a delete per file. Asks run PURGE_CONCURRENCY at a time, so a thousand
 * asks take a few seconds against DeleteMeFn's 29 s timeout. If asks grow
 * into the tens of thousands, keep a USER#{sub} / HUBASK#{askId} pointer on
 * claim and file creation and walk only those.
 */
import {
  AbortMultipartUploadCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import { DeleteCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { ASKS_ALL_GSI1PK, GSI1, askClaimKey, getDocClient } from "../db";

let s3: S3Client | undefined;
const getS3 = (): S3Client => (s3 ??= new S3Client({}));

export interface HubPurgeResult {
  asks: number;
  rows: number;
  objects: number;
}

const errName = (err: unknown): string | undefined => (err as { name?: string }).name;

/** Asks purged at once. Each holds up to a handful of DynamoDB and S3 calls. */
export const PURGE_CONCURRENCY = 16;

async function queryAll(input: ConstructorParameters<typeof QueryCommand>[0]): Promise<Record<string, unknown>[]> {
  const items: Record<string, unknown>[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const page = await getDocClient().send(new QueryCommand({ ...input, ExclusiveStartKey: startKey }));
    items.push(...((page.Items ?? []) as Record<string, unknown>[]));
    startKey = page.LastEvaluatedKey;
  } while (startKey);
  return items;
}

/** Every object under the prefix, deleted in pages of up to 1000. */
async function deletePrefix(bucket: string, prefix: string): Promise<number> {
  let deleted = 0;
  let token: string | undefined;
  do {
    const page = await getS3().send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }));
    const keys = (page.Contents ?? []).flatMap((o) => (o.Key ? [{ Key: o.Key }] : []));
    if (keys.length > 0) {
      await getS3().send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys, Quiet: true } }));
      deleted += keys.length;
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return deleted;
}

/** One ask: the member's open uploads, stored files, file rows and claim. */
async function purgeAsk(sub: string, askId: string, bucket: string, table: string, result: HubPurgeResult): Promise<void> {
  const files = await queryAll({
    TableName: table,
    KeyConditionExpression: "PK = :pk AND begins_with(SK, :f)",
    ExpressionAttributeValues: { ":pk": `ASK#${askId}`, ":f": `FILE#${sub}#` },
  });
  // Files first, rows after, so a retry still finds what is left.
  for (const file of files) {
    if (typeof file["uploadId"] === "string" && typeof file["key"] === "string") {
      await getS3()
        .send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: file["key"], UploadId: file["uploadId"] }))
        .catch((err: unknown) => {
          if (errName(err) !== "NoSuchUpload") throw err;
        });
    }
  }
  try {
    result.objects += await deletePrefix(bucket, `submissions/${askId}/${sub}/`);
  } catch (err) {
    // A stage without the portal has no bucket, and nothing to delete in it.
    if (errName(err) !== "NoSuchBucket") throw err;
  }
  for (const file of files) {
    await getDocClient().send(new DeleteCommand({ TableName: table, Key: { PK: file["PK"], SK: file["SK"] } }));
    result.rows++;
  }
  const claim = await getDocClient().send(
    new DeleteCommand({ TableName: table, Key: askClaimKey(askId, sub), ReturnValues: "ALL_OLD" }),
  );
  if (claim.Attributes) result.rows++;
}

export async function purgeHubData(sub: string, bucket: string, table: string): Promise<HubPurgeResult> {
  const result: HubPurgeResult = { asks: 0, rows: 0, objects: 0 };
  const asks = await queryAll({
    TableName: table,
    IndexName: GSI1,
    KeyConditionExpression: "GSI1PK = :pk",
    ExpressionAttributeValues: { ":pk": ASKS_ALL_GSI1PK },
    ProjectionExpression: "id",
  });
  const ids = asks.flatMap((ask) => (typeof ask["id"] === "string" ? [ask["id"]] : []));
  result.asks = ids.length;
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < ids.length) {
      const askId = ids[next++]!;
      await purgeAsk(sub, askId, bucket, table, result);
    }
  };
  // Any failure rejects the whole purge: delete-me stops before Cognito, and a retry starts over.
  await Promise.all(Array.from({ length: Math.min(PURGE_CONCURRENCY, ids.length) }, worker));
  return result;
}
