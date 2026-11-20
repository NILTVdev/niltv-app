/**
 * GET /v1/my-posts (portal API) — an athlete's clips on niltv.com: the
 * published content credited to their ath-* profile, newest first.
 *
 * The portal account is linked to the profile by Instagram handle the first
 * time it is needed (the roster sync does the same), then remembered on the
 * member row.
 */
import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { MyPostsResponse } from "@niltv/types";
import { GSI2, athleteGsiPk, getDocClient } from "../../lib/db";
import { can, denied } from "../../lib/portal/access";
import { ensureProfileLink } from "../../lib/portal/profiles";
import { ok, portalHandler } from "../../lib/portal/router";
import { resolveThumbUrl } from "../../lib/shape";

const table = (): string => process.env.TABLE_NAME ?? "";

export const handler = portalHandler({
  "GET /v1/my-posts": async ({ caller }) => {
    if (!can(caller, "athleteTools")) return denied();
    const member = await ensureProfileLink(caller.member);
    if (!member.profileId) return ok(MyPostsResponse.parse({ linked: false, posts: [] }));
    const out = await getDocClient().send(
      new QueryCommand({
        TableName: table(),
        IndexName: GSI2,
        KeyConditionExpression: "GSI2PK = :pk",
        ExpressionAttributeValues: { ":pk": athleteGsiPk(member.profileId) },
        ScanIndexForward: false,
        Limit: 60,
      }),
    );
    const posts = (out.Items ?? [])
      .filter((row) => typeof row["id"] === "string" && row["removed"] !== true)
      .map((row) => {
        const posterUrl = resolveThumbUrl(row);
        return {
          id: row["id"] as string,
          title: typeof row["title"] === "string" ? row["title"] : "Untitled",
          ...(posterUrl ? { posterUrl } : {}),
          ...(typeof row["channelId"] === "string" ? { channelId: row["channelId"] } : {}),
          ...(typeof row["publishedAt"] === "string" ? { publishedAt: row["publishedAt"] } : {}),
          views: typeof row["views"] === "number" ? row["views"] : 0,
        };
      });
    return ok(MyPostsResponse.parse({ linked: true, posts }));
  },
});
