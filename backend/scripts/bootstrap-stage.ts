/**
 * Bootstrap a stage's table with REAL launch data — the anti-seed (seed.ts
 * loads demo fixtures and must never touch prod). Creates exactly:
 *   - CONFIG#app (flags dark, no active event — set after the first real event)
 *   - the three property channels (NIL TV / TrueBlue TV / NILTV Esports)
 * Campus channels are auto-created by the ingest bridge on its first run.
 * Idempotent: plain puts, safe to re-run.
 *
 *   TABLE_NAME=niltv-prod npx tsx scripts/bootstrap-stage.ts
 */
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { channelKey, configKey, getDocClient } from "../src/lib/db";

const TABLE = process.env.TABLE_NAME ?? "";

const CHANNELS = [
  {
    id: "ch-niltv",
    name: "NIL TV",
    kind: "niltv",
    color: "#C2A030",
    about: "The flagship NILTV channel.",
  },
  {
    id: "ch-trueblue",
    name: "TrueBlue TV",
    kind: "trueblue",
    color: "#003087",
    about: "The Duke cornerstone channel.",
  },
  {
    id: "ch-esports",
    name: "NILTV Esports",
    kind: "esports",
    color: "#C2A030",
    about: "College esports on NILTV.",
  },
] as const;

async function main() {
  if (!TABLE) throw new Error("Set TABLE_NAME");
  const db = getDocClient();

  await db.send(
    new PutCommand({
      TableName: TABLE,
      Item: {
        ...configKey(),
        flags: { liveSegment: false, ambassadorDirectory: false },
        minAppVersion: "0.1.0",
        channelIds: CHANNELS.map((c) => c.id),
      },
    }),
  );
  console.log("CONFIG#app written");

  for (const channel of CHANNELS) {
    await db.send(
      new PutCommand({ TableName: TABLE, Item: { ...channelKey(channel.id), ...channel } }),
    );
    console.log(`channel ${channel.id} written`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
