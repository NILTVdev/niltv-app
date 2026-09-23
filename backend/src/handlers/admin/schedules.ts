/**
 * EventBridge Scheduler one-shots for the event lifecycle (design §6.5, §7):
 * every admin event save re-syncs three schedules — `…-live` at startsAt,
 * `…-ended` at endsAt and `…-closing` at endsAt − 24h (the "closing soon"
 * broadcast, notification only) — each firing the event-transition Lambda
 * once and deleting itself (ActionAfterCompletion). A boundary already in
 * the past is deleted instead of created, so re-editing an old event never
 * errors and a stale one-shot from a previous date can't fire later.
 */
import {
  ConflictException,
  CreateScheduleCommand,
  DeleteScheduleCommand,
  ResourceNotFoundException,
  SchedulerClient,
  type CreateScheduleCommandInput,
  UpdateScheduleCommand,
} from "@aws-sdk/client-scheduler";
let schedulerClient: SchedulerClient | undefined;
const getScheduler = (): SchedulerClient => (schedulerClient ??= new SchedulerClient({}));

/** The three per-event one-shots: two status boundaries + the closing-soon broadcast. */
export type ScheduleKind = "live" | "ended" | "closing";

/** Schedule name for one boundary — visible in the console, so keep it legible. */
export const scheduleName = (prefix: string, eventId: string, kind: ScheduleKind): string =>
  `${prefix}-ev-${eventId}-${kind}`;

/** `at(yyyy-mm-ddThh:mm:ss)` — Scheduler's one-shot expression (UTC, no ms/zone suffix). */
export const atExpression = (iso: string): string =>
  `at(${new Date(iso).toISOString().slice(0, 19)})`;

interface SyncEventSchedulesEnv {
  /** `niltv-{stage}` — schedule name prefix. */
  prefix: string;
  /** event-transition Lambda the one-shots invoke. */
  transitionFnArn: string;
  /** Role Scheduler assumes to invoke it. */
  schedulerRoleArn: string;
}

/** Read the scheduler wiring from the handler env; throws when unset (deploy bug, fail loudly). */
export function schedulesEnv(): SyncEventSchedulesEnv {
  const prefix = process.env.SCHEDULE_PREFIX;
  const transitionFnArn = process.env.TRANSITION_FN_ARN;
  const schedulerRoleArn = process.env.SCHEDULER_ROLE_ARN;
  if (!prefix || !transitionFnArn || !schedulerRoleArn) {
    throw new Error("scheduler env missing (SCHEDULE_PREFIX / TRANSITION_FN_ARN / SCHEDULER_ROLE_ARN)");
  }
  return { prefix, transitionFnArn, schedulerRoleArn };
}

/** Fire time of the closing-soon broadcast (design §7): ends_at − 24h. */
export const closingSoonAt = (endsAt: string): string =>
  new Date(Date.parse(endsAt) - 24 * 60 * 60 * 1000).toISOString();

/** Upsert or retire all three one-shots for an event's current dates. */
export async function syncEventSchedules(
  env: SyncEventSchedulesEnv,
  eventId: string,
  startsAt: string,
  endsAt: string,
  now: Date = new Date(),
): Promise<void> {
  await Promise.all([
    syncOneShot(env, eventId, "live", startsAt, now),
    syncOneShot(env, eventId, "ended", endsAt, now),
    syncOneShot(env, eventId, "closing", closingSoonAt(endsAt), now),
  ]);
}

async function syncOneShot(
  env: SyncEventSchedulesEnv,
  eventId: string,
  kind: ScheduleKind,
  fireAt: string,
  now: Date,
): Promise<void> {
  const name = scheduleName(env.prefix, eventId, kind);
  const scheduler = getScheduler();

  // Past boundary → make sure no stale one-shot survives, then stop.
  if (Date.parse(fireAt) <= now.getTime()) {
    try {
      await scheduler.send(new DeleteScheduleCommand({ Name: name }));
    } catch (err) {
      if (!(err instanceof ResourceNotFoundException)) throw err;
    }
    return;
  }

  const input: CreateScheduleCommandInput = {
    Name: name,
    Description: `niltv event ${eventId} → ${kind} (design §6.5/§7 one-shot)`,
    ScheduleExpression: atExpression(fireAt),
    ScheduleExpressionTimezone: "UTC",
    FlexibleTimeWindow: { Mode: "OFF" },
    ActionAfterCompletion: "DELETE",
    Target: {
      Arn: env.transitionFnArn,
      RoleArn: env.schedulerRoleArn,
      // closing is notification-only; live/ended are status transitions.
      Input: JSON.stringify(kind === "closing" ? { eventId, notify: "closingSoon" } : { eventId, to: kind }),
      RetryPolicy: { MaximumRetryAttempts: 3, MaximumEventAgeInSeconds: 3600 },
    },
  };

  try {
    await scheduler.send(new CreateScheduleCommand(input));
  } catch (err) {
    if (!(err instanceof ConflictException)) throw err;
    await scheduler.send(new UpdateScheduleCommand(input));
  }
}
