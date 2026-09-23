/**
 * Seed the DynamoDB table with the fixtures from @niltv/types/fixtures.
 *
 *   npm run seed -- --table niltv-dev
 *   TABLE_NAME=niltv-dev npm run seed
 *   npm run seed -- --table niltv-dev --keep-orphans   # puts only, no deletes
 *
 * Credentials come from the standard AWS chain (profile `default` per
 * conventions). Idempotent: plain puts keyed per design §5 — re-running
 * overwrites the same items.
 *
 * Seeding RECONCILES the event slate: puts alone cannot express a removal, so
 * dropping an event from the fixtures used to leave it live in the table and
 * still listed on the NIL STAR tab. After writing, this deletes event and
 * entry rows the fixtures no longer name — but ONLY rows this script wrote.
 *
 * Provenance is the whole safety story. Seeded rows carry `seedSource:
 * "fixtures"`; anything created through the admin panel does not, and is never
 * touched. Without that guard a seed run against prod would silently delete
 * real admin-created events. The same rule protects admin-added finalists on a
 * seeded event: they survive every later seed.
 *
 * Votes (USER#…/VOTE#…) are user-owned rows and are always left alone.
 * Pass --keep-orphans to skip the delete pass entirely.
 */
import {
  BatchWriteCommand,
  type BatchWriteCommandInput,
  type PutCommandInput,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  fixtureChannels,
  fixtureConfig,
  fixtureContent,
  fixtureEntries,
  fixtureEvents,
  fixtureProfiles,
} from "@niltv/types/fixtures";
import {
  EVENTS_ALL_GSI1PK,
  GSI1,
  channelKey,
  configKey,
  contentKey,
  entryKey,
  eventKey,
  getDocClient,
  profileKey,
} from "../src/lib/db";

type Item = NonNullable<PutCommandInput["Item"]>;
type WriteRequests = NonNullable<BatchWriteCommandInput["RequestItems"]>[string];
type Key = { PK: string; SK: string };

const BATCH_SIZE = 25;
const MAX_RETRIES = 8;

/**
 * Provenance marker stamped on every event/entry row this script writes. The
 * reconcile pass only ever deletes rows carrying it, so admin-created records
 * are safe from a seed run.
 */
const SEED_SOURCE = "fixtures";

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

/** All seed items, keyed exactly per the design §5 table. */
function buildItems(): Array<{ entity: string; item: Item }> {
  const items: Array<{ entity: string; item: Item }> = [];

  // channelIds is the /v1/channels source list (handler falls back to the
  // launch trio when absent) — seeded in fixture order.
  items.push({
    entity: "config",
    item: { ...configKey(), ...fixtureConfig, channelIds: fixtureChannels.map((channel) => channel.id) },
  });

  for (const channel of fixtureChannels) {
    items.push({ entity: "channels", item: { ...channelKey(channel.id), ...channel } });
  }

  for (const profile of fixtureProfiles) {
    items.push({
      entity: "profiles",
      item: {
        ...profileKey(profile.id),
        GSI1PK: "PROFILES#ALL",
        // Rank-first ordering per design §5: ranked ambassadors sort ahead
        // ("01" < "02" < … < any letter), everyone else alphabetically by name.
        GSI1SK:
          profile.ambassadorRank !== undefined
            ? String(profile.ambassadorRank).padStart(2, "0")
            : profile.name,
        ...profile,
      },
    });
  }

  for (const event of fixtureEvents) {
    items.push({
      entity: "events",
      item: {
        ...eventKey(event.id),
        GSI1PK: "EVENTS#ALL",
        GSI1SK: `${event.status}#${event.startsAt}`,
        seedSource: SEED_SOURCE,
        ...event,
      },
    });
  }

  for (const entry of fixtureEntries) {
    items.push({
      entity: "entries",
      item: {
        ...entryKey(entry.eventId, entry.id),
        GSI1PK: `ATHLETE#${entry.athleteId}`,
        GSI1SK: `ENTRY#${entry.eventId}`,
        seedSource: SEED_SOURCE,
        ...entry,
      },
    });
  }

  for (const content of fixtureContent) {
    // GSI rows are sparse: only playable, rights-cleared clips enter the
    // Watch/creator indexes — unplayable rows can never appear in public grids.
    // NOTE: the future admin publish Lambda must mirror this exact rule.
    const gsi =
      content.transcodeStatus === "published" && content.rightsConfirmed
        ? {
            GSI1PK: `CHANNEL#${content.channelId}`,
            GSI1SK: content.publishedAt,
            GSI2PK: `ATHLETE#${content.athleteId}`,
            GSI2SK: content.publishedAt,
          }
        : {};
    items.push({ entity: "content", item: { ...contentKey(content.id), ...gsi, ...content } });
  }

  return items;
}

async function writeBatch(tableName: string, batch: Item[]): Promise<void> {
  let requests: WriteRequests = batch.map((item) => ({ PutRequest: { Item: item } }));

  for (let attempt = 0; requests.length > 0; attempt++) {
    if (attempt > MAX_RETRIES) {
      throw new Error(`gave up after ${MAX_RETRIES} retries with ${requests.length} unprocessed items`);
    }
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** attempt));
    }
    const result = await getDocClient().send(
      new BatchWriteCommand({ RequestItems: { [tableName]: requests } }),
    );
    requests = (result.UnprocessedItems?.[tableName] ?? []) as WriteRequests;
  }
}

async function deleteBatch(tableName: string, keys: Key[]): Promise<void> {
  for (let i = 0; i < keys.length; i += BATCH_SIZE) {
    let requests: WriteRequests = keys
      .slice(i, i + BATCH_SIZE)
      .map((Key) => ({ DeleteRequest: { Key } }));
    for (let attempt = 0; requests.length > 0; attempt++) {
      if (attempt > MAX_RETRIES) {
        throw new Error(`gave up after ${MAX_RETRIES} retries with ${requests.length} unprocessed deletes`);
      }
      if (attempt > 0) {
        await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** attempt));
      }
      const result = await getDocClient().send(
        new BatchWriteCommand({ RequestItems: { [tableName]: requests } }),
      );
      requests = (result.UnprocessedItems?.[tableName] ?? []) as WriteRequests;
    }
  }
}

/**
 * Every EVENT# item this script has written before — META rows via GSI1, then
 * the ENTRY# rows beneath each event. Rows without the provenance marker are
 * skipped: they came from the admin panel and are not ours to delete.
 */
async function seededEventKeys(tableName: string): Promise<Key[]> {
  const db = getDocClient();
  const keys: Key[] = [];
  const eventIds: string[] = [];

  let start: Record<string, unknown> | undefined;
  do {
    const out = await db.send(
      new QueryCommand({
        TableName: tableName,
        IndexName: GSI1,
        KeyConditionExpression: "GSI1PK = :pk",
        ExpressionAttributeValues: { ":pk": EVENTS_ALL_GSI1PK },
        ExclusiveStartKey: start,
      }),
    );
    for (const item of out.Items ?? []) {
      // Every event's entries are scanned (an admin event can hold seeded
      // entries), but only seeded META rows are deletion candidates.
      eventIds.push(String(item["id"]));
      if (item["seedSource"] === SEED_SOURCE) {
        keys.push({ PK: String(item["PK"]), SK: String(item["SK"]) });
      }
    }
    start = out.LastEvaluatedKey;
  } while (start);

  for (const id of eventIds) {
    let itemStart: Record<string, unknown> | undefined;
    do {
      const out = await db.send(
        new QueryCommand({
          TableName: tableName,
          KeyConditionExpression: "PK = :pk AND begins_with(SK, :entry)",
          ExpressionAttributeValues: { ":pk": eventKey(id).PK, ":entry": "ENTRY#" },
          ProjectionExpression: "PK, SK, seedSource",
          ExclusiveStartKey: itemStart,
        }),
      );
      for (const item of out.Items ?? []) {
        if (item["seedSource"] !== SEED_SOURCE) continue;
        keys.push({ PK: String(item["PK"]), SK: String(item["SK"]) });
      }
      itemStart = out.LastEvaluatedKey;
    } while (itemStart);
  }
  return keys;
}

/** Previously-seeded keys that the current fixtures no longer name. */
async function orphanEventKeys(tableName: string): Promise<Key[]> {
  const wanted = new Set<string>();
  for (const event of fixtureEvents) {
    const key = eventKey(event.id);
    wanted.add(`${key.PK}|${key.SK}`);
  }
  for (const entry of fixtureEntries) {
    const key = entryKey(entry.eventId, entry.id);
    wanted.add(`${key.PK}|${key.SK}`);
  }
  const present = await seededEventKeys(tableName);
  return present.filter((key) => !wanted.has(`${key.PK}|${key.SK}`));
}

async function main(): Promise<void> {
  const tableName = argValue("--table") ?? process.env.TABLE_NAME;
  if (!tableName) {
    console.error("Usage: tsx scripts/seed.ts --table <table-name> [--keep-orphans]");
    process.exitCode = 1;
    return;
  }
  // Prod latch: its channels/config/events are real records (admin-created,
  // ingest-fed). A fixture seed would overwrite evt-nilstar-s1, clobber the
  // 7-channel config, and inject demo athletes/clips. Refuse outright.
  if (/prod/i.test(tableName)) {
    console.error(`${tableName} looks like production — seeding fixtures into prod is not supported.`);
    process.exitCode = 1;
    return;
  }

  const items = buildItems();
  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    await writeBatch(
      tableName,
      items.slice(i, i + BATCH_SIZE).map((entry) => entry.item),
    );
  }

  const counts = new Map<string, number>();
  for (const { entity } of items) {
    counts.set(entity, (counts.get(entity) ?? 0) + 1);
  }

  console.log(`Seeded ${items.length} items into ${tableName}:`);
  for (const [entity, count] of counts) {
    console.log(`  ${entity.padEnd(10)} ${count}`);
  }

  if (process.argv.includes("--keep-orphans")) {
    console.log("\nSkipped event reconcile (--keep-orphans).");
    return;
  }

  const orphans = await orphanEventKeys(tableName);
  if (orphans.length === 0) {
    console.log("\nEvent slate matches the fixtures — nothing to remove.");
    return;
  }
  for (const key of orphans) {
    console.log(`  remove   ${key.PK} / ${key.SK}`);
  }
  await deleteBatch(tableName, orphans);
  console.log(`\nRemoved ${orphans.length} event items no longer in the fixtures.`);
}

main().catch((err) => {
  console.error("seed failed:", err);
  process.exitCode = 1;
});
