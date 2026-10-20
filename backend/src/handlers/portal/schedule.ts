/**
 * Portal schedule (portal API): events, time polls and weekly availability,
 * mostly for lining up gaming sessions, streams and shoots.
 *
 *   GET  /v1/events                      events the caller is invited to (staff: all)
 *   POST /v1/events                      staff: one time = a set event, more = a time poll
 *   PUT  /v1/events/{id}                 staff: edit
 *   POST /v1/events/{id}/action          lock | cancel (staff) · vote | rsvp (invitees)
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
  EventActionRequest,
  EventUpsertRequest,
  EventsResponse,
  type PortalEvent,
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
import { type Caller, can, denied } from "../../lib/portal/access";
import { audienceIncludes, audienceLabel, resolveAudience } from "../../lib/portal/audience";
import { listMemberships } from "../../lib/portal/conversations";
import { newPortalId } from "../../lib/portal/ids";
import { formerMember, getMembers, toPerson } from "../../lib/portal/members";
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
  invitedCount: z.number().int().default(0),
});
type StoredEvent = z.infer<typeof StoredEvent>;

const KEEP_PAST_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

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
    .filter((e) => e.status === "poll" || lastTime(e) >= cutoff);
}

/** Every vote and RSVP on an event (staff view). */
async function repliesFor(id: string): Promise<{ votes: Map<string, string[]>; rsvps: Map<string, RsvpStatus> }> {
  const votes = new Map<string, string[]>();
  const rsvps = new Map<string, RsvpStatus>();
  let startKey: Record<string, unknown> | undefined;
  do {
    const page = await getDocClient().send(
      new QueryCommand({
        TableName: table(),
        KeyConditionExpression: "PK = :pk",
        ExpressionAttributeValues: { ":pk": `PEVENT#${id}` },
        ExclusiveStartKey: startKey,
      }),
    );
    for (const item of page.Items ?? []) {
      const sk = String(item["SK"] ?? "");
      if (sk.startsWith("VOTE#") && Array.isArray(item["optionIds"])) votes.set(sk.slice(5), item["optionIds"] as string[]);
      if (sk.startsWith("RSVP#")) {
        const status = RsvpStatus.safeParse(item["status"]);
        if (status.success) rsvps.set(sk.slice(5), status.data);
      }
    }
    startKey = page.LastEvaluatedKey;
  } while (startKey);
  return { votes, rsvps };
}

/** The caller's own vote and RSVP across many events, in one BatchGet per 50 events. */
async function myReplies(events: StoredEvent[], sub: string): Promise<Map<string, { votes: string[]; rsvp?: RsvpStatus }>> {
  const out = new Map<string, { votes: string[]; rsvp?: RsvpStatus }>();
  for (let i = 0; i < events.length; i += 50) {
    const keys = events
      .slice(i, i + 50)
      .flatMap((e) => [{ ...portalEventVoteKey(e.id, sub) }, { ...portalEventRsvpKey(e.id, sub) }]);
    const res = await getDocClient().send(new BatchGetCommand({ RequestItems: { [table()]: { Keys: keys } } }));
    for (const item of res.Responses?.[table()] ?? []) {
      const id = String(item["PK"] ?? "").slice("PEVENT#".length);
      const entry = out.get(id) ?? { votes: [] };
      if (String(item["SK"]).startsWith("VOTE#") && Array.isArray(item["optionIds"])) entry.votes = item["optionIds"] as string[];
      if (String(item["SK"]).startsWith("RSVP#")) {
        const status = RsvpStatus.safeParse(item["status"]);
        if (status.success) entry.rsvp = status.data;
      }
      out.set(id, entry);
    }
  }
  return out;
}

function present(e: StoredEvent, mine: { votes: string[]; rsvp?: RsvpStatus } | undefined): PortalEvent {
  const { createdBySub: _by, ...rest } = e;
  const optionIds = new Set(e.options.map((o) => o.id));
  return {
    ...rest,
    myVotes: (mine?.votes ?? []).filter((id) => optionIds.has(id)),
    ...(mine?.rsvp ? { myRsvp: mine.rsvp } : {}),
  };
}

async function groupIdsOf(caller: Caller): Promise<Set<string>> {
  return new Set((await listMemberships(caller.sub)).filter((m) => m.kind === "group" && !m.marker).map((m) => m.convId));
}

async function isInvited(caller: Caller, e: StoredEvent): Promise<boolean> {
  if (isStaffRole(caller.member.role)) return true;
  return audienceIncludes(e.audience, caller.member, await groupIdsOf(caller));
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

    // Staff see who picked what.
    const replies = await Promise.all(visible.map((e) => repliesFor(e.id)));
    const subs = replies.flatMap((r) => [...r.votes.keys(), ...r.rsvps.keys()]);
    const people = await getMembers(subs);
    const person = (sub: string): PortalPerson => {
      const m = people.get(sub);
      return m ? toPerson(m) : formerMember(sub);
    };
    const events = visible.map((e, i) => {
      const { votes, rsvps } = replies[i]!;
      return {
        ...present(e, mine.get(e.id)),
        votes: e.options.map((o) => ({
          optionId: o.id,
          people: [...votes.entries()].filter(([, ids]) => ids.includes(o.id)).map(([sub]) => person(sub)),
        })),
        rsvps: [...rsvps.entries()].map(([sub, status]) => ({ person: person(sub), status })),
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
      updatedAt: new Date().toISOString(),
    };
    await getDocClient().send(new PutCommand({ TableName: table(), Item: eventItem(event) }));
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
        if (!event.options.some((o) => o.id === req.optionId)) return badRequest("Unknown time.");
        await db.send(
          new UpdateCommand({
            TableName: table(),
            Key: portalEventKey(event.id),
            UpdateExpression: "SET #s = :set, lockedOptionId = :o, updatedAt = :now",
            ExpressionAttributeNames: { "#s": "status" },
            ExpressionAttributeValues: { ":set": "set", ":o": req.optionId, ":now": now },
          }),
        );
        await enqueue({ type: "event.locked", eventId: event.id });
        return ok(present({ ...event, status: "set", lockedOptionId: req.optionId, updatedAt: now }, undefined));
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
        if (event.status !== "poll") return badRequest("This time is already set.");
        const valid = new Set(event.options.map((o) => o.id));
        const optionIds = [...new Set(req.optionIds)].filter((id) => valid.has(id));
        await db.send(
          new PutCommand({
            TableName: table(),
            Item: { ...portalEventVoteKey(event.id, caller.sub), optionIds, at: now },
          }),
        );
        return ok(present(event, { votes: optionIds }));
      }
      case "rsvp": {
        if (event.status !== "set") return badRequest("Pick a time first.");
        await db.send(
          new PutCommand({
            TableName: table(),
            Item: { ...portalEventRsvpKey(event.id, caller.sub), status: req.status, at: now },
          }),
        );
        return ok(present(event, { votes: [], rsvp: req.status }));
      }
    }
  },

  "GET /v1/availability": async ({ caller }) => {
    const out = await getDocClient().send(new GetCommand({ TableName: table(), Key: availabilityKey(caller.sub) }));
    const parsed = Availability.safeParse(out.Item ?? {});
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
        const slots = Array.isArray(item["slots"]) ? (item["slots"] as string[]) : [];
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
