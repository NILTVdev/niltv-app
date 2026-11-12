/**
 * Portal members: the USER#{sub} / PORTAL row is the whole access decision.
 * It is read on every request (src/lib/portal/access.ts), so removing access
 * or changing a role takes effect on the next call, with no token lag.
 */
import { BatchGetCommand, GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { type Desk, PortalMember, PortalSettings, type PortalPerson, desksFor, isStaffRole } from "@niltv/types";
import { GSI1, PORTAL_MEMBERS_GSI1PK, getDocClient, portalConfigKey, portalMemberGsi, portalMemberKey } from "../db";

const table = (): string => process.env.TABLE_NAME ?? "";

const KEY_FIELDS = new Set(["PK", "SK", "GSI1PK", "GSI1SK", "GSI2PK", "GSI2SK"]);

/** Strip key attributes and parse; undefined when the row is not a valid member. */
export function parseMember(item: Record<string, unknown> | undefined): PortalMember | undefined {
  if (!item) return undefined;
  const fields = Object.fromEntries(Object.entries(item).filter(([k]) => !KEY_FIELDS.has(k)));
  const parsed = PortalMember.safeParse(fields);
  if (!parsed.success) {
    console.warn("portal: unreadable member row", item["PK"], parsed.error.issues[0]);
    return undefined;
  }
  return parsed.data;
}

export const memberItem = (member: PortalMember): Record<string, unknown> => ({
  ...portalMemberKey(member.sub),
  ...portalMemberGsi(member.name, member.sub),
  ...member,
});

export async function getMember(sub: string): Promise<PortalMember | undefined> {
  const out = await getDocClient().send(new GetCommand({ TableName: table(), Key: portalMemberKey(sub) }));
  return parseMember(out.Item);
}

export async function putMember(member: PortalMember): Promise<void> {
  await getDocClient().send(new PutCommand({ TableName: table(), Item: memberItem(member) }));
}

/** "Seen" is refreshed at most this often: fine enough for an hour-long summary delay and a 3-minute push check. */
export const SEEN_EVERY_MS = 2 * 60 * 1000;

/**
 * Record that the member is in the portal now. One attribute, so it never
 * overwrites a concurrent edit to the rest of the row.
 */
export async function touchSeen(member: PortalMember, now: Date = new Date()): Promise<PortalMember> {
  if (member.lastSeenAt && now.getTime() - Date.parse(member.lastSeenAt) < SEEN_EVERY_MS) return member;
  const at = now.toISOString();
  try {
    await getDocClient().send(
      new UpdateCommand({
        TableName: table(),
        Key: portalMemberKey(member.sub),
        UpdateExpression: "SET lastSeenAt = :at",
        ConditionExpression: "attribute_exists(PK)",
        ExpressionAttributeValues: { ":at": at },
      }),
    );
  } catch (err) {
    console.warn("portal: last-seen write failed", err);
  }
  return { ...member, lastSeenAt: at };
}

/** Create only; false when the account already has a portal row. */
export async function createMember(member: PortalMember): Promise<boolean> {
  try {
    await getDocClient().send(
      new PutCommand({
        TableName: table(),
        Item: memberItem(member),
        ConditionExpression: "attribute_not_exists(PK)",
      }),
    );
    return true;
  } catch (err) {
    if ((err as { name?: string }).name === "ConditionalCheckFailedException") return false;
    throw err;
  }
}

/** Every member, all statuses, ordered by name. A few hundred rows at most. */
export async function listMembers(): Promise<PortalMember[]> {
  const out: PortalMember[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const page = await getDocClient().send(
      new QueryCommand({
        TableName: table(),
        IndexName: GSI1,
        KeyConditionExpression: "GSI1PK = :pk",
        ExpressionAttributeValues: { ":pk": PORTAL_MEMBERS_GSI1PK },
        ExclusiveStartKey: startKey,
      }),
    );
    for (const item of page.Items ?? []) {
      const member = parseMember(item);
      if (member) out.push(member);
    }
    startKey = page.LastEvaluatedKey;
  } while (startKey);
  return out;
}

/** Members by sub (BatchGet, 100 per call). Missing subs are simply absent. */
export async function getMembers(subs: readonly string[]): Promise<Map<string, PortalMember>> {
  const unique = [...new Set(subs)];
  const found = new Map<string, PortalMember>();
  for (let i = 0; i < unique.length; i += 100) {
    let keys = unique.slice(i, i + 100).map((sub) => ({ ...portalMemberKey(sub) }) as Record<string, unknown>);
    for (let attempt = 0; keys.length > 0 && attempt < 5; attempt++) {
      const out = await getDocClient().send(
        new BatchGetCommand({ RequestItems: { [table()]: { Keys: keys } } }),
      );
      for (const item of out.Responses?.[table()] ?? []) {
        const member = parseMember(item);
        if (member) found.set(member.sub, member);
      }
      keys = (out.UnprocessedKeys?.[table()]?.Keys ?? []) as Record<string, unknown>[];
    }
  }
  return found;
}

export const isActive = (member: PortalMember | undefined): member is PortalMember =>
  member !== undefined && member.status === "active";

export const toPerson = (member: PortalMember): PortalPerson => ({
  sub: member.sub,
  name: member.name,
  role: member.role,
  ...(member.campus ? { campus: member.campus } : {}),
  ...(member.sport ? { sport: member.sport } : {}),
});

/** Stand-in for a member row that no longer exists (deleted account). */
export const formerMember = (sub: string): PortalPerson => ({ sub, name: "Former member", role: "athlete" });

export async function getSettings(): Promise<PortalSettings> {
  const out = await getDocClient().send(new GetCommand({ TableName: table(), Key: portalConfigKey() }));
  const { PK: _pk, SK: _sk, ...rest } = (out.Item ?? {}) as Record<string, unknown>;
  const parsed = PortalSettings.safeParse(rest);
  return parsed.success ? parsed.data : PortalSettings.parse({});
}

export async function putSettings(settings: PortalSettings): Promise<void> {
  await getDocClient().send(
    new PutCommand({ TableName: table(), Item: { ...portalConfigKey(), ...settings } }),
  );
}

/** Active staff who answer a desk and keep it in their desk list. */
export async function deskStaff(desk: Desk): Promise<PortalMember[]> {
  return (await listMembers()).filter(
    (m) => m.status === "active" && isStaffRole(m.role) && m.desks.includes(desk) && desksFor(m.role).includes(desk),
  );
}

/** Where a desk's alerts go: the addresses in Settings, else the desk's staff. */
export async function deskRecipients(desk: Desk, settings: PortalSettings): Promise<string[]> {
  const listed = settings.deskEmails[desk] ?? [];
  return [...new Set(listed.length ? listed : (await deskStaff(desk)).map((m) => m.email))];
}
