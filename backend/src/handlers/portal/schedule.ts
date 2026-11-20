/**
 * Portal schedule (portal API): events, time polls and weekly availability,
 * mostly for lining up gaming sessions, streams and shoots.
 *
 *   GET  /v1/events                      events the caller is invited to (staff: all)
 *   POST /v1/events                      staff: one time = a set event, more = a time poll
 *   PUT  /v1/events/{id}                 staff: edit
 *   POST /v1/events/{id}/action          lock | reopen | remind | cancel (staff) · vote | rsvp (invitees)
 *   GET  /v1/availability                my weekly availability
 *   PUT  /v1/availability
 *   GET  /v1/availability/heatmap        staff: ?type=everyone|campus|sport|group&value=
 *
 * Times are stored in UTC; every screen shows them in the viewer's zone.
 */
import { GetCommand, PutCommand, QueryCommand, UpdateCommand, BatchGetCommand } from "@aws-sdk/lib-dynamodb";
import {
  Audience,
  Availability,
  AvailabilityHeatmap,
  upgradeSlots,
  EventActionRequest,
  EventUpsertRequest,
  EventsResponse,
  type PortalEvent,
  type PortalMember,
  PortalEventKind,
  PortalEventStatus,
  type PortalPerson,
  RsvpStatus,
  TimeOption,
  isStaffRole,
} from "@niltv/types";
import { z } from "zod";
import {
  AVAIL_ALL_GSI1PK,
  GSI1,
  PORTAL_EVENTS_GSI1PK,
  availabilityKey,
  getDocClient,
  portalEventKey,
  portalEventRsvpKey,
  portalEventVoteKey,
} from "../../lib/db";
import { type Caller, can, conflictResult, denied } from "../../lib/portal/access";
import { audienceIncludes, audienceLabel, resolveAudience } from "../../lib/portal/audience";
import { listMemberships } from "../../lib/portal/conversations";
import { type VoteRow, clearRsvps, eventReplies, hasAnswered, markGoing } from "../../lib/portal/events";
import { newPortalId } from "../../lib/portal/ids";
import { formerMember, getMembers, getSettings, toPerson } from "../../lib/portal/members";
import { enqueue } from "../../lib/portal/notify";
import { badRequest, notFound, ok, portalHandler } from "../../lib/portal/router";

const table = (): string => process.env.TABLE_NAME ?? "";

/** The row as stored (PEVENT#{id} / META). */
const StoredEvent = z.object({
  id: z.string(),
  title: z.string(),
  kind: PortalEventKind,
  description: z.string().default(""),
  location: z.string().optional(),
  streamUrl: z.string().optional(),
  status: PortalEventStatus,
  options: z.array(TimeOption),
  lockedOptionId: z.string().optional(),
  audience: Audience,
  audienceLabel: z.string(),
  createdBySub: z.string(),
  createdByName: z.string(),
  createdAt: z.string(),
  updatedAt: z.string().optional(),
  /** when a time was last added: everyone is asked again */
  timesChangedAt: z.string().optional(),
  remindedAt: z.string().optional(),
  invitedCount: z.number().int().default(0),
});
type StoredEvent = z.infer<typeof StoredEvent>;

const KEEP_PAST_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
/** The most names one list carries; the count covers the rest. */
const WAITING_SHOWN = 20;

/** Option ids come from the start time, so an edit that keeps a time keeps its votes. */
export const optionId = (startsAt: string): string => `o-${Date.parse(startsAt).toString(36)}`;

export function buildOptions(input: { startsAt: string; endsAt?: string | undefined }[]): TimeOption[] | undefined {
  const seen = new Set<string>();
  const out: TimeOption[] = [];
  for (const o of [...input].sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt))) {
    if (o.endsAt && Date.parse(o.endsAt) <= Date.parse(o.startsAt)) return undefined;
    const id = optionId(o.startsAt);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, startsAt: new Date(o.startsAt).toISOString(), ...(o.endsAt ? { endsAt: new Date(o.endsAt).toISOString() } : {}) });
  }
  return out;
}

/** When the event is over: the locked time, or the last option of a poll. */
function lastTime(e: StoredEvent): number {
  const opts = e.lockedOptionId ? e.options.filter((o) => o.id === e.lockedOptionId) : e.options;
  return Math.max(0, ...opts.map((o) => Date.parse(o.endsAt ?? o.startsAt)));
}

const eventItem = (e: StoredEvent): Record<string, unknown> => ({
  ...portalEventKey(e.id),
  GSI1PK: PORTAL_EVENTS_GSI1PK,
  GSI1SK: `${e.createdAt}#${e.id}`,
  ...e,
});

async function getEvent(id: string): Promise<StoredEvent | undefined> {
  const out = await getDocClient().send(new GetCommand({ TableName: table(), Key: portalEventKey(id) }));
  const parsed = StoredEvent.safeParse(out.Item ?? {});
  return parsed.success ? parsed.data : undefined;
}

async function listEvents(): Promise<StoredEvent[]> {
  const out = await getDocClient().send(
    new QueryCommand({
      TableName: table(),
      IndexName: GSI1,
      KeyConditionExpression: "GSI1PK = :pk",
      ExpressionAttributeValues: { ":pk": PORTAL_EVENTS_GSI1PK },
      ScanIndexForward: false,
      Limit: 300,
    }),
  );
  const cutoff = Date.now() - KEEP_PAST_DAYS * DAY_MS;
  return (out.Items ?? [])
    .map((item) => StoredEvent.safeParse(item))
    .filter((p): p is { success: true; data: StoredEvent } => p.success)
    .map((p) => p.data)
    .filter((e) => lastTime(e) >= cutoff);
}

interface MyReply {
  vote?: VoteRow;
  rsvp?: RsvpStatus;
}

/** The caller's own vote and RSVP across many events, in one BatchGet per 50 events. */
async function myReplies(events: StoredEvent[], sub: string): Promise<Map<string, MyReply>> {
  const out = new Map<string, MyReply>();
  for (let i = 0; i < events.length; i += 50) {
    const keys = events
      .slice(i, i + 50)
      .flatMap((e) => [{ ...portalEventVoteKey(e.id, sub) }, { ...portalEventRsvpKey(e.id, sub) }]);
    const res = await getDocClient().send(new BatchGetCommand({ RequestItems: { [table()]: { Keys: keys } } }));
    for (const item of res.Responses?.[table()] ?? []) {
      const id = String(item["PK"] ?? "").slice("PEVENT#".length);
      const entry = out.get(id) ?? {};
      if (String(item["SK"]).startsWith("VOTE#") && Array.isArray(item["optionIds"])) {
        entry.vote = { optionIds: item["optionIds"] as string[], at: item["at"] as string | undefined };
      }
      if (String(item["SK"]).startsWith("RSVP#")) {
        const status = RsvpStatus.safeParse(item["status"]);
        if (status.success) entry.rsvp = status.data;
      }
      out.set(id, entry);
    }
  }
  return out;
}

function present(e: StoredEvent, mine: MyReply | undefined): PortalEvent {
  const { createdBySub: _by, timesChangedAt: _changed, ...rest } = e;
  const optionIds = new Set(e.options.map((o) => o.id));
  return {
    ...rest,
    myVotes: (mine?.vote?.optionIds ?? []).filter((id) => optionIds.has(id)),
    myAnswered: hasAnswered(e, mine?.vote),
    ...(mine?.rsvp ? { myRsvp: mine.rsvp } : {}),
  };
}

const hasStarted = (o: { startsAt: string }, now: number): boolean => Date.parse(o.startsAt) <= now;

async function groupIdsOf(caller: Caller): Promise<Set<string>> {
  return new Set((await listMemberships(caller.sub)).filter((m) => m.kind === "group" && !m.marker).map((m) => m.convId));
}

async function isInvited(caller: Caller, e: StoredEvent): Promise<boolean> {
  if (isStaffRole(caller.member.role)) return true;
  return audienceIncludes(e.audience, caller.member, await groupIdsOf(caller));
}

/** Change an event only if it is still in the status the caller saw. False when it was not. */
async function moveStatus(id: string, from: PortalEvent["status"], update: string, values: Record<string, unknown>): Promise<boolean> {
  try {
    await getDocClient().send(
      new UpdateCommand({
        TableName: table(),
        Key: portalEventKey(id),
        UpdateExpression: update,
        ConditionExpression: "#s = :from",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: { ":from": from, ...values },
      }),
    );
    return true;
  } catch (err) {
    if ((err as { name?: string }).name === "ConditionalCheckFailedException") return false;
    throw err;
  }
}

const HeatmapQuery = z.object({
  type: z.enum(["everyone", "campus", "sport", "group"]).default("everyone"),
  value: z.string().optional(),
});

export const handler = portalHandler({
  "GET /v1/events": async ({ caller }) => {
    const all = await listEvents();
    const staff = isStaffRole(caller.member.role);
    const groups = staff ? new Set<string>() : await groupIdsOf(caller);
    const visible = staff ? all : all.filter((e) => audienceIncludes(e.audience, caller.member, groups));
    const mine = await myReplies(visible, caller.sub);
    if (!staff) return ok(EventsResponse.parse({ events: visible.map((e) => present(e, mine.get(e.id))) }));

    // Staff see who picked what, and who has not answered.
    const replies = await Promise.all(visible.map((e) => eventReplies(e.id)));
    const audiences = new Map<string, Promise<PortalMember[]>>();
    const invitedTo = (e: StoredEvent): Promise<PortalMember[]> => {
      const key = JSON.stringify(e.audience);
      const known = audiences.get(key) ?? resolveAudience(e.audience);
      audiences.set(key, known);
      return known;
    };
    const invited = await Promise.all(visible.map((e) => (e.status === "poll" ? invitedTo(e) : [])));
    const subs = replies.flatMap((r) => [...r.votes.keys(), ...r.rsvps.keys()]);
    const people = await getMembers(subs);
    const person = (sub: string): PortalPerson => {
      const m = people.get(sub);
      return m ? toPerson(m) : formerMember(sub);
    };
    const events = visible.map((e, i) => {
      const { votes, rsvps } = replies[i]!;
      const waiting = invited[i]!.filter((m) => !hasAnswered(e, votes.get(m.sub)));
      return {
        ...present(e, mine.get(e.id)),
        votes: e.options.map((o) => ({
          optionId: o.id,
          people: [...votes.entries()].filter(([, v]) => v.optionIds.includes(o.id)).map(([sub]) => person(sub)),
        })),
        rsvps: [...rsvps.entries()].map(([sub, status]) => ({ person: person(sub), status })),
        ...(e.status === "poll"
          ? {
              noneWork: [...votes.entries()].filter(([, v]) => v.optionIds.length === 0 && hasAnswered(e, v)).map(([sub]) => person(sub)),
              waiting: waiting.slice(0, WAITING_SHOWN).map(toPerson),
              waitingCount: waiting.length,
              invitedCount: invited[i]!.length,
            }
          : {}),
      };
    });
    return ok(EventsResponse.parse({ events }));
  },

  "POST /v1/events": async ({ caller, body }) => {
    if (!can(caller, "manageEvents")) return denied();
    const req = body(EventUpsertRequest);
    if (!req) return badRequest();
    const options = buildOptions(req.options);
    if (!options || options.length === 0) return badRequest("Each time needs an end after its start.");
    const invited = await resolveAudience(req.audience);
    const now = new Date().toISOString();
    const event: StoredEvent = {
      id: newPortalId("ev"),
      title: req.title,
      kind: req.kind,
      description: req.description,
      ...(req.location ? { location: req.location } : {}),
      ...(req.streamUrl ? { streamUrl: req.streamUrl } : {}),
      status: options.length === 1 ? "set" : "poll",
      options,
      ...(options.length === 1 ? { lockedOptionId: options[0]!.id } : {}),
      audience: req.audience,
      audienceLabel: await audienceLabel(req.audience),
      createdBySub: caller.sub,
      createdByName: caller.member.name,
      createdAt: now,
      invitedCount: invited.length,
    };
    await getDocClient().send(new PutCommand({ TableName: table(), Item: eventItem(event) }));
    await enqueue({ type: "event.new", eventId: event.id });
    return ok(present(event, undefined), 201);
  },

  "PUT /v1/events/{id}": async ({ caller, body, param }) => {
    if (!can(caller, "manageEvents")) return denied();
    const req = body(EventUpsertRequest);
    if (!req) return badRequest();
    const current = await getEvent(param("id"));
    if (!current) return notFound();
    const options = buildOptions(req.options);
    if (!options || options.length === 0) return badRequest("Each time needs an end after its start.");
    const lockedStillThere = current.lockedOptionId && options.some((o) => o.id === current.lockedOptionId);
    const status = current.status === "cancelled" ? "cancelled" : options.length === 1 ? "set" : lockedStillThere ? "set" : "poll";
    const lockedOptionId = status === "set" ? (lockedStillThere ? current.lockedOptionId : options[0]!.id) : undefined;
    const known = new Set(current.options.map((o) => o.id));
    const added = options.some((o) => !known.has(o.id));
    const timesChanged = added || options.length !== current.options.length;
    const nowIso = new Date().toISOString();
    const event: StoredEvent = {
      ...current,
      title: req.title,
      kind: req.kind,
      description: req.description,
      location: req.location,
      streamUrl: req.streamUrl,
      options,
      status,
      lockedOptionId,
      audience: req.audience,
      audienceLabel: await audienceLabel(req.audience),
      invitedCount: (await resolveAudience(req.audience)).length,
      updatedAt: nowIso,
      // A new time asks everyone again, so nobody is left answering the old list.
      ...(status === "poll" && added ? { timesChangedAt: nowIso } : {}),
    };
    await getDocClient().send(new PutCommand({ TableName: table(), Item: eventItem(event) }));
    if (current.status === "set" && status === "poll") {
      await clearRsvps(event.id, [...(await eventReplies(event.id)).rsvps.keys()]);
    }
    if (status === "poll" && timesChanged) await enqueue({ type: "event.times", eventId: event.id });
    // A set event that moved tells its invitees (right away when it is close).
    const before = current.status === "set" ? current.options.find((o) => o.id === current.lockedOptionId) : undefined;
    const after = event.status === "set" ? event.options.find((o) => o.id === event.lockedOptionId) : undefined;
    if (before && after && before.startsAt !== after.startsAt) {
      await enqueue({ type: "event.changed", eventId: event.id, previousStartsAt: before.startsAt });
    }
    return ok(present(event, undefined));
  },

  "POST /v1/events/{id}/action": async ({ caller, body, param }) => {
    const req = body(EventActionRequest);
    if (!req) return badRequest();
    const event = await getEvent(param("id"));
    if (!event || !(await isInvited(caller, event))) return notFound();
    const now = new Date().toISOString();
    const db = getDocClient();

    switch (req.action) {
      case "lock": {
        if (!can(caller, "manageEvents")) return denied();
        const option = event.options.find((o) => o.id === req.optionId);
        if (!option) return badRequest("Unknown time.");
        if (hasStarted(option, Date.now())) return badRequest("That time has passed.");
        // Only an event still waiting on a time can lock, so a stale screen cannot revive a
        // cancelled event or overwrite a colleague's choice.
        if (!(await moveStatus(event.id, "poll", "SET #s = :to, lockedOptionId = :o, updatedAt = :now", { ":to": "set", ":o": req.optionId, ":now": now }))) {
          return conflictResult("CONFLICT", "This event changed. Refresh to see it.");
        }
        const { votes, rsvps } = await eventReplies(event.id);
        const going = [...votes.entries()].filter(([sub, v]) => v.optionIds.includes(req.optionId) && !rsvps.has(sub)).map(([sub]) => sub);
        await markGoing(event.id, going, now);
        await enqueue({ type: "event.locked", eventId: event.id });
        return ok(present({ ...event, status: "set", lockedOptionId: req.optionId, updatedAt: now }, undefined));
      }
      case "reopen": {
        if (!can(caller, "manageEvents")) return denied();
        if (event.options.length < 2) return badRequest("This event only has one time.");
        if (!(await moveStatus(event.id, "set", "SET #s = :to, updatedAt = :now REMOVE lockedOptionId", { ":to": "poll", ":now": now }))) {
          return conflictResult("CONFLICT", "This event changed. Refresh to see it.");
        }
        await clearRsvps(event.id, [...(await eventReplies(event.id)).rsvps.keys()]);
        await enqueue({ type: "event.times", eventId: event.id });
        const { lockedOptionId: _locked, ...open } = event;
        return ok(present({ ...open, status: "poll", updatedAt: now }, undefined));
      }
      case "remind": {
        if (!can(caller, "manageEvents")) return denied();
        if (event.status !== "poll") return conflictResult("CONFLICT", "This event is not waiting on a time.");
        const settings = await getSettings();
        if (!settings.activityEmails && !settings.webPush) {
          return conflictResult("CONFLICT", "Notifications are off, so a reminder cannot reach anyone yet.");
        }
        try {
          await db.send(
            new UpdateCommand({
              TableName: table(),
              Key: portalEventKey(event.id),
              UpdateExpression: "SET remindedAt = :now",
              ConditionExpression: "attribute_not_exists(remindedAt) OR remindedAt < :cutoff",
              ExpressionAttributeValues: { ":now": now, ":cutoff": new Date(Date.now() - DAY_MS).toISOString() },
            }),
          );
        } catch (err) {
          if ((err as { name?: string }).name !== "ConditionalCheckFailedException") throw err;
          return conflictResult("CONFLICT", "A reminder already went out today.");
        }
        await enqueue({ type: "event.reminder", eventId: event.id });
        return ok(present({ ...event, remindedAt: now }, undefined));
      }
      case "cancel": {
        if (!can(caller, "manageEvents")) return denied();
        await db.send(
          new UpdateCommand({
            TableName: table(),
            Key: portalEventKey(event.id),
            UpdateExpression: "SET #s = :c, updatedAt = :now",
            ExpressionAttributeNames: { "#s": "status" },
            ExpressionAttributeValues: { ":c": "cancelled", ":now": now },
          }),
        );
        if (event.status !== "cancelled") await enqueue({ type: "event.cancelled", eventId: event.id });
        return ok(present({ ...event, status: "cancelled", updatedAt: now }, undefined));
      }
      case "vote": {
        if (event.status === "cancelled") return badRequest("This event was cancelled.");
        if (event.status !== "poll") return badRequest("This time is already set.");
        const open = event.options.filter((o) => !hasStarted(o, Date.now()));
        if (open.length === 0) return badRequest("These times have passed.");
        const valid = new Set(open.map((o) => o.id));
        const optionIds = [...new Set(req.optionIds)].filter((id) => valid.has(id));
        await db.send(
          new PutCommand({
            TableName: table(),
            Item: { ...portalEventVoteKey(event.id, caller.sub), optionIds, at: now },
          }),
        );
        return ok(present(event, { vote: { optionIds, at: now } }));
      }
      case "rsvp": {
        if (event.status === "cancelled") return badRequest("This event was cancelled.");
        if (event.status !== "set") return badRequest("Pick a time first.");
        await db.send(
          new PutCommand({
            TableName: table(),
            Item: { ...portalEventRsvpKey(event.id, caller.sub), status: req.status, at: now },
          }),
        );
        return ok(present(event, { rsvp: req.status }));
      }
    }
  },

  "GET /v1/availability": async ({ caller }) => {
    const out = await getDocClient().send(new GetCommand({ TableName: table(), Key: availabilityKey(caller.sub) }));
    const parsed = Availability.safeParse({ ...out.Item, slots: upgradeSlots(out.Item?.["slots"]) });
    return ok(parsed.success ? parsed.data : { slots: [] });
  },

  "PUT /v1/availability": async ({ caller, body }) => {
    const req = body(Availability);
    if (!req) return badRequest();
    const item = {
      slots: [...new Set(req.slots)],
      ...(req.timezone ? { timezone: req.timezone } : caller.member.timezone ? { timezone: caller.member.timezone } : {}),
      updatedAt: new Date().toISOString(),
    };
    await getDocClient().send(
      new PutCommand({
        TableName: table(),
        Item: { ...availabilityKey(caller.sub), GSI1PK: AVAIL_ALL_GSI1PK, GSI1SK: caller.sub, ...item },
      }),
    );
    return ok(Availability.parse(item));
  },

  "GET /v1/availability/heatmap": async ({ caller, query }) => {
    if (!can(caller, "viewAvailability")) return denied();
    const q = HeatmapQuery.safeParse({ type: query("type") ?? undefined, value: query("value") ?? undefined });
    if (!q.success) return badRequest();
    const { type, value } = q.data;
    if (type !== "everyone" && !value) return badRequest("value is required");
    const audience: Audience =
      type === "everyone"
        ? { type }
        : type === "campus"
          ? { type, campus: value! }
          : type === "sport"
            ? { type, sport: value! }
            : { type, convId: value! };
    const invited = await resolveAudience(audience);
    const names = new Map(invited.map((m) => [m.sub, m.name]));

    const counts = new Map<string, string[]>();
    let responded = 0;
    let startKey: Record<string, unknown> | undefined;
    do {
      const page = await getDocClient().send(
        new QueryCommand({
          TableName: table(),
          IndexName: GSI1,
          KeyConditionExpression: "GSI1PK = :pk",
          ExpressionAttributeValues: { ":pk": AVAIL_ALL_GSI1PK },
          ExclusiveStartKey: startKey,
        }),
      );
      for (const item of page.Items ?? []) {
        const sub = String(item["GSI1SK"] ?? "");
        const name = names.get(sub);
        if (!name) continue;
        const slots = upgradeSlots(item["slots"]);
        if (slots.length > 0) responded++;
        for (const slot of slots) counts.set(slot, [...(counts.get(slot) ?? []), name]);
      }
      startKey = page.LastEvaluatedKey;
    } while (startKey);

    return ok(
      AvailabilityHeatmap.parse({
        responded,
        invited: invited.length,
        cells: [...counts.entries()].map(([slot, list]) => ({ slot, count: list.length, names: list.sort() })),
      }),
    );
  },
});
