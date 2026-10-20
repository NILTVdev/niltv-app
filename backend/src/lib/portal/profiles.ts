/**
 * Link a portal athlete to their ath-* profile on niltv.com by Instagram
 * handle (current or previous), the join the roster sync already uses.
 */
import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { PortalMember } from "@niltv/types";
import { GSI1, PROFILES_ALL_GSI1PK, getDocClient } from "../db";
import { putMember } from "./members";

const table = (): string => process.env.TABLE_NAME ?? "";

const normalizeHandle = (h: string): string => h.trim().replace(/^@/, "").toLowerCase();

/** Profile id whose current or previous handle matches, or undefined. */
export async function findProfileIdByHandle(handle: string): Promise<string | undefined> {
  const wanted = normalizeHandle(handle);
  if (!wanted) return undefined;
  let startKey: Record<string, unknown> | undefined;
  do {
    const page = await getDocClient().send(
      new QueryCommand({
        TableName: table(),
        IndexName: GSI1,
        KeyConditionExpression: "GSI1PK = :pk",
        ExpressionAttributeValues: { ":pk": PROFILES_ALL_GSI1PK },
        ProjectionExpression: "id, handle, previousHandles",
        ExclusiveStartKey: startKey,
      }),
    );
    for (const item of page.Items ?? []) {
      const handles = [item["handle"], ...((item["previousHandles"] as unknown[] | undefined) ?? [])]
        .filter((h): h is string => typeof h === "string")
        .map(normalizeHandle);
      if (handles.includes(wanted) && typeof item["id"] === "string") return item["id"];
    }
    startKey = page.LastEvaluatedKey;
  } while (startKey);
  return undefined;
}

export async function ensureProfileLink(member: PortalMember): Promise<PortalMember> {
  if (member.profileId || !member.instagram) return member;
  const profileId = await findProfileIdByHandle(member.instagram);
  if (!profileId) return member;
  const linked = { ...member, profileId };
  await putMember(linked);
  return linked;
}
