import { beforeEach, describe, expect, it, vi } from "vitest";

const schedulerSendMock = vi.hoisted(() => vi.fn());

vi.mock("@aws-sdk/client-scheduler", () => {
  class NamedError extends Error {}
  class ConflictException extends NamedError {}
  class ResourceNotFoundException extends NamedError {}
  const command = (kind: string) =>
    class {
      readonly kind = kind;
      constructor(public readonly input: Record<string, unknown>) {}
    };
  return {
    SchedulerClient: class {
      send = schedulerSendMock;
    },
    CreateScheduleCommand: command("create"),
    UpdateScheduleCommand: command("update"),
    DeleteScheduleCommand: command("delete"),
    ConflictException,
    ResourceNotFoundException,
  };
});

import { ConflictException, ResourceNotFoundException } from "@aws-sdk/client-scheduler";
import { atExpression, scheduleName, syncEventSchedules } from "./schedules";

const env = { prefix: "niltv-dev", transitionFnArn: "arn:fn", schedulerRoleArn: "arn:role" };
const sentCommands = () =>
  schedulerSendMock.mock.calls.map((c) => c[0] as { kind: string; input: Record<string, any> });

describe("event lifecycle one-shots (design §6.5)", () => {
  beforeEach(() => {
    schedulerSendMock.mockReset();
    schedulerSendMock.mockResolvedValue({});
  });

  it("formats at() expressions without ms/zone suffix", () => {
    expect(atExpression("2026-09-07T12:30:00.000Z")).toBe("at(2026-09-07T12:30:00)");
  });

  it("creates all three one-shots for a future window, self-deleting after completion", async () => {
    const now = new Date("2026-09-01T00:00:00Z");
    await syncEventSchedules(env, "ev-x", "2026-09-07T00:00:00.000Z", "2026-09-25T00:00:00.000Z", now);

    const creates = sentCommands();
    expect(creates).toHaveLength(3);
    const live = creates.find((c) => c.input["Name"] === scheduleName("niltv-dev", "ev-x", "live"));
    const ended = creates.find((c) => c.input["Name"] === scheduleName("niltv-dev", "ev-x", "ended"));
    const closing = creates.find((c) => c.input["Name"] === scheduleName("niltv-dev", "ev-x", "closing"));
    expect(live?.kind).toBe("create");
    expect(live?.input).toMatchObject({
      ScheduleExpression: "at(2026-09-07T00:00:00)",
      ActionAfterCompletion: "DELETE",
      FlexibleTimeWindow: { Mode: "OFF" },
    });
    expect(JSON.parse(live?.input["Target"]?.Input ?? "")).toEqual({ eventId: "ev-x", to: "live" });
    expect(JSON.parse(ended?.input["Target"]?.Input ?? "")).toEqual({ eventId: "ev-x", to: "ended" });
    // closing soon: ends_at − 24h, notification-only payload (design §7).
    expect(closing?.input["ScheduleExpression"]).toBe("at(2026-09-24T00:00:00)");
    expect(JSON.parse(closing?.input["Target"]?.Input ?? "")).toEqual({
      eventId: "ev-x",
      notify: "closingSoon",
    });
  });

  it("a past boundary deletes any stale one-shot instead of creating one", async () => {
    const now = new Date("2026-09-24T12:00:00Z"); // closing window passed too, end ahead
    await syncEventSchedules(env, "ev-x", "2026-09-07T00:00:00.000Z", "2026-09-25T00:00:00.000Z", now);

    const commands = sentCommands();
    const kinds = Object.fromEntries(commands.map((c) => [c.input["Name"], c.kind]));
    expect(kinds[scheduleName("niltv-dev", "ev-x", "live")]).toBe("delete");
    expect(kinds[scheduleName("niltv-dev", "ev-x", "closing")]).toBe("delete");
    expect(kinds[scheduleName("niltv-dev", "ev-x", "ended")]).toBe("create");
  });

  it("tolerates deleting a one-shot that never existed", async () => {
    schedulerSendMock.mockRejectedValue(new ResourceNotFoundException("nope" as never));
    const now = new Date("2026-10-01T00:00:00Z"); // both boundaries past
    await expect(
      syncEventSchedules(env, "ev-x", "2026-09-07T00:00:00.000Z", "2026-09-25T00:00:00.000Z", now),
    ).resolves.toBeUndefined();
  });

  it("re-saving updates an existing one-shot (create conflict → update)", async () => {
    schedulerSendMock
      .mockRejectedValueOnce(new ConflictException("exists" as never))
      .mockResolvedValue({});
    const now = new Date("2026-09-01T00:00:00Z");
    await syncEventSchedules(env, "ev-x", "2026-09-08T00:00:00.000Z", "2026-09-26T00:00:00.000Z", now);

    const kinds = sentCommands().map((c) => c.kind);
    expect(kinds).toContain("update");
  });
});
