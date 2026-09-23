/**
 * Channel roster reconciliation: the network's official campus
 * channel list is exactly TEN channels. This script makes a stage's data
 * match it — creates missing channel rows + their p-{account} pseudo-profiles
 * (same shapes ingest-social mints) and appends them to CONFIG#app.channelIds.
 * Non-roster campus channels are REPORTED; pass --remove-nonroster to drop
 * them from the directory (refused if they still own content).
 *
 * Run:  npx tsx scripts/ensure-channel-roster.ts --stage dev
 *       npx tsx scripts/ensure-channel-roster.ts --stage prod --confirm-prod
 */
import { DeleteCommand, GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { Channel, Profile } from "@niltv/types";
import {
  GSI1,
  channelContentGsi1Pk,
  channelKey,
  configKey,
  getDocClient,
  profileKey,
} from "../src/lib/db";

/** account slug → display name; ch-{slug} / p-{slug} follow from it. */
const ROSTER: Record<string, string> = {
  brazostv: "Brazos TV",
  chapelhilltv: "Chapel Hill TV",
  collegestationtv: "College Station TV",
  truebluetv: "TrueBlue TV",
  dorecitytv: "Dore City TV",
  goldendometv: "Golden Dome TV",
  goldsalemtv: "Gold Salem TV",
  redpacktv: "Red Pack TV",
  saltcitytv: "Salt City TV",
  starkvilletv: "Starkville TV",
};
/** Network sources are not campus channels and always stay. */
const NETWORK = new Set(["ch-niltv", "ch-nilstar"]);

const STAGES = { dev: "niltv-dev", prod: "niltv-prod" } as const;
const args = process.argv.slice(2);
const stageArg = args[args.indexOf("--stage") + 1];
const stage = stageArg === "dev" || stageArg === "prod" ? stageArg : undefined;
if (!stage) throw new Error("usage: --stage dev|prod [--confirm-prod] [--remove-nonroster]");
if (stage === "prod" && !args.includes("--confirm-prod")) {
  throw new Error("prod roster changes: pass --confirm-prod");
}
const REMOVE = args.includes("--remove-nonroster");
const TABLE = STAGES[stage];

async function main() {
  process.env["AWS_REGION"] = process.env["AWS_REGION"] ?? "us-east-1";
  const db = getDocClient();
  console.log(`ensure-channel-roster: stage=${stage} table=${TABLE}`);

  const { Item: cfg } = await db.send(new GetCommand({ TableName: TABLE, Key: configKey() }));
  const channelIds: string[] = [...((cfg?.["channelIds"] as string[] | undefined) ?? [])];

  for (const [account, name] of Object.entries(ROSTER)) {
    const channelId = `ch-${account}`;
    const { Item: chRow } = await db.send(new GetCommand({ TableName: TABLE, Key: channelKey(channelId) }));
    if (!chRow) {
      const channel = Channel.parse({
        id: channelId,
        name,
        kind: "campus",
        about: `Clips from @${account} on Instagram.`,
      });
      await db.send(new PutCommand({ TableName: TABLE, Item: { ...channelKey(channelId), ...channel } }));
      console.log(`created channel ${channelId} ("${name}")`);
    }
    const profileId = `p-${account}`;
    const { Item: prRow } = await db.send(new GetCommand({ TableName: TABLE, Key: profileKey(profileId) }));
    if (!prRow) {
      const profile = Profile.parse({
        id: profileId,
        name,
        handle: account,
        school: "",
        sport: "",
        bio: `Official ${name} channel.`,
      });
      await db.send(new PutCommand({ TableName: TABLE, Item: { ...profileKey(profileId), ...profile } }));
      console.log(`created profile ${profileId}`);
    }
    if (!channelIds.includes(channelId)) channelIds.push(channelId);
  }

  // Non-roster campus channels in the directory: report, optionally remove.
  const rosterIds = new Set(Object.keys(ROSTER).map((a) => `ch-${a}`));
  const strays = channelIds.filter((id) => !rosterIds.has(id) && !NETWORK.has(id));
  for (const id of strays) {
    if (!REMOVE) {
      console.log(`NON-ROSTER channel in directory (kept; use --remove-nonroster): ${id}`);
      continue;
    }
    const owned = await db.send(
      new QueryCommand({
        TableName: TABLE,
        IndexName: GSI1,
        KeyConditionExpression: "GSI1PK = :pk",
        ExpressionAttributeValues: { ":pk": channelContentGsi1Pk(id) },
        Limit: 1,
      }),
    );
    if ((owned.Items ?? []).length > 0) {
      console.log(`NON-ROSTER ${id} still owns content — NOT removed`);
      continue;
    }
    channelIds.splice(channelIds.indexOf(id), 1);
    await db.send(new DeleteCommand({ TableName: TABLE, Key: channelKey(id) }));
    console.log(`removed non-roster channel ${id}`);
  }

  await db.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: configKey(),
      UpdateExpression: "SET channelIds = :ids",
      ExpressionAttributeValues: { ":ids": channelIds },
    }),
  );
  console.log(`CONFIG#app.channelIds = [${channelIds.join(", ")}]`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
