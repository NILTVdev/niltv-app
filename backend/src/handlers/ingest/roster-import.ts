/**
 * roster-import — scheduled daily at 06:15 UTC, so a newly welcomed
 * ambassador has a Profile row before their collab posts are enriched.
 * Reads GET /api/ambassadors/ (the network programme) and GET /api/athletes/
 * (the Duke roster) with the same API key as the bridge.
 */
import type { ScheduledHandler } from "aws-lambda";
import { dashboardApiKey, fetchRoster, importRoster } from "../../lib/roster";

export const handler: ScheduledHandler = async () => {
  const table = process.env.TABLE_NAME ?? "";
  const baseUrl = process.env.DASHBOARD_API_URL ?? "";
  const apiKey = await dashboardApiKey(process.env.DASHBOARD_API_KEY_PARAM ?? "");
  const ambassadors = await fetchRoster(baseUrl, apiKey);
  const result = await importRoster(table, ambassadors);
  console.log(
    `roster-import: ${ambassadors.length} ambassadors → ${result.created} created, ${result.updated} updated, ${result.skipped} skipped`,
  );
};
