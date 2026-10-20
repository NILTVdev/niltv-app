/**
 * Who a schedule event is for. "everyone" means every active athlete; staff
 * see every event regardless. Group audiences follow the group's current
 * members, so adding someone to the group invites them to its events.
 */
import { type Audience, CAMPUS_CHANNELS, type PortalMember, isStaffRole } from "@niltv/types";
import { getConv, memberSubs } from "./conversations";
import { getMembers, listMembers } from "./members";

/** Active members the audience names (staff excluded unless named directly). */
export async function resolveAudience(audience: Audience): Promise<PortalMember[]> {
  switch (audience.type) {
    case "everyone":
      return (await listMembers()).filter((m) => m.status === "active" && m.role === "athlete");
    case "campus":
      return (await listMembers()).filter(
        (m) => m.status === "active" && m.role === "athlete" && m.campus === audience.campus,
      );
    case "sport":
      return (await listMembers()).filter(
        (m) => m.status === "active" && m.role === "athlete" && m.sport === audience.sport,
      );
    case "group": {
      const subs = await memberSubs(audience.convId);
      return [...(await getMembers(subs)).values()].filter((m) => m.status === "active");
    }
    case "people":
      return [...(await getMembers(audience.subs)).values()].filter((m) => m.status === "active");
  }
}

/** Is this member invited? `groupIds` = the groups they belong to. */
export function audienceIncludes(audience: Audience, member: PortalMember, groupIds: ReadonlySet<string>): boolean {
  if (isStaffRole(member.role)) return true;
  switch (audience.type) {
    case "everyone":
      return member.role === "athlete";
    case "campus":
      return member.role === "athlete" && member.campus === audience.campus;
    case "sport":
      return member.role === "athlete" && member.sport === audience.sport;
    case "group":
      return groupIds.has(audience.convId);
    case "people":
      return audience.subs.includes(member.sub);
  }
}

export async function audienceLabel(audience: Audience): Promise<string> {
  switch (audience.type) {
    case "everyone":
      return "Every athlete";
    case "campus":
      return `${CAMPUS_CHANNELS[audience.campus]?.school ?? audience.campus} athletes`;
    case "sport":
      return audience.sport;
    case "group":
      return (await getConv(audience.convId))?.title ?? "A group";
    case "people":
      return audience.subs.length === 1 ? "1 person" : `${audience.subs.length} people`;
  }
}
