import { beforeEach, describe, expect, it, vi } from "vitest";

const sendMock = vi.hoisted(() => vi.fn());
const syncMock = vi.hoisted(() => vi.fn());

vi.mock("../../lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/db")>();
  return {
    ...actual,
    getDocClient: () => ({ send: sendMock }),
  };
});

vi.mock("./schedules", () => ({
  schedulesEnv: () => ({ prefix: "niltv-test", transitionFnArn: "arn:fn", schedulerRoleArn: "arn:role" }),
  syncEventSchedules: syncMock,
}));

import { handler, initialStatus } from "./event-upsert";

async function invoke(event: Record<string, unknown>) {
  const result = await handler(event as never, {} as never, () => undefined);
  if (result === undefined || typeof result === "string") {
    throw new Error("expected a structured APIGatewayProxyStructuredResultV2");
  }
  return result;
}

const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

function upsertEvent(body: unknown, staff = true) {
  return {
    body: JSON.stringify(body),
    requestContext: {
      http: { method: "POST" },
      authorizer: { jwt: { claims: staff ? { "cognito:groups": "[staff]" } : {} } },
    },
  };
}

const futureWindow = () => ({ startsAt: iso(3_600_000), endsAt: iso(7_200_000) });

describe("POST /admin/events — upsert + one-shot sync (design §6.5)", () => {
  beforeEach(() => {
    sendMock.mockReset();
    syncMock.mockReset();
    process.env.TABLE_NAME = "niltv-test";
  });

  it("initialStatus derives from the dates once, at create", () => {
    const now = new Date("2026-09-10T00:00:00Z");
    expect(initialStatus("2026-09-11T00:00:00Z", "2026-09-12T00:00:00Z", now)).toBe("upcoming");
    expect(initialStatus("2026-09-09T00:00:00Z", "2026-09-12T00:00:00Z", now)).toBe("live");
    expect(initialStatus("2026-09-01T00:00:00Z", "2026-09-09T00:00:00Z", now)).toBe("ended");
  });

  it("denies non-staff", async () => {
    const res = await invoke(upsertEvent({ title: "NIL TEST STAR", ...futureWindow() }, false));
    expect(res.statusCode).toBe(403);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("rejects an inverted window", async () => {
    const res = await invoke(
      upsertEvent({ title: "NIL TEST STAR", startsAt: iso(7_200_000), endsAt: iso(3_600_000) }),
    );
    expect(res.statusCode).toBe(400);
    expect(syncMock).not.toHaveBeenCalled();
  });

  it("create: assigns an ev- id, derives status, writes GSI keys, then syncs the one-shots", async () => {
    sendMock.mockResolvedValueOnce({});
    const window = futureWindow();

    const res = await invoke(
      upsertEvent({ title: "NIL TEST STAR", prize: "$10,000", partners: ["Rap Nation"], ...window }),
    );

    expect(res.statusCode).toBe(201);
    const created = JSON.parse(res.body ?? "");
    expect(created.id).toMatch(/^ev-nil-test-star-[0-9a-f]{4}$/);
    expect(created.status).toBe("upcoming");

    const put = (sendMock.mock.calls[0]?.[0] as { input: Record<string, any> }).input;
    expect(put.Item).toMatchObject({
      PK: `EVENT#${created.id}`,
      SK: "META",
      GSI1PK: "EVENTS#ALL",
      GSI1SK: `upcoming#${window.startsAt}`,
      status: "upcoming",
      type: "vote",
    });
    expect(put.ConditionExpression).toBe("attribute_not_exists(PK)");

    expect(syncMock).toHaveBeenCalledWith(
      expect.objectContaining({ prefix: "niltv-test" }),
      created.id,
      window.startsAt,
      window.endsAt,
    );
  });

  it("update: 404s when the event does not exist", async () => {
    sendMock.mockResolvedValueOnce({});
    const res = await invoke(upsertEvent({ id: "ev-x", title: "Renamed", ...futureWindow() }));
    expect(res.statusCode).toBe(404);
    expect(syncMock).not.toHaveBeenCalled();
  });

  it("update: preserves stored status + frozen recap, rebuilds GSI1SK from the new startsAt", async () => {
    const window = futureWindow();
    const recap = { championEntryId: "en-a", leaderboard: [], totals: { votes: 1, entries: 1, daysLive: 1 } };
    sendMock
      .mockResolvedValueOnce({
        Item: {
          PK: "EVENT#ev-x",
          SK: "META",
          id: "ev-x",
          title: "Old title",
          status: "ended",
          startsAt: iso(-7_200_000),
          endsAt: iso(-3_600_000),
          recap,
        },
      })
      .mockResolvedValueOnce({});

    const res = await invoke(upsertEvent({ id: "ev-x", title: "New title", ...window }));

    expect(res.statusCode).toBe(200);
    const put = (sendMock.mock.calls[1]?.[0] as { input: Record<string, any> }).input;
    expect(put.Item).toMatchObject({
      id: "ev-x",
      title: "New title",
      status: "ended",
      GSI1SK: `ended#${window.startsAt}`,
      recap,
    });
    expect(put.ConditionExpression).toBeUndefined();
    expect(syncMock).toHaveBeenCalledWith(expect.anything(), "ev-x", window.startsAt, window.endsAt);
  });
});
