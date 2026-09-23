import { beforeEach, describe, expect, it, vi } from "vitest";

const sendMock = vi.hoisted(() => vi.fn());

vi.mock("../../lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/db")>();
  return {
    ...actual,
    getDocClient: () => ({ send: sendMock }),
  };
});

import { handler } from "./content-upsert";

async function invoke(event: Record<string, unknown>) {
  const result = await handler(event as never, {} as never, () => undefined);
  if (result === undefined || typeof result === "string") {
    throw new Error("expected a structured APIGatewayProxyStructuredResultV2");
  }
  return result;
}

function upsertEvent(body: unknown, staff = true) {
  return {
    body: typeof body === "string" ? body : JSON.stringify(body),
    requestContext: {
      http: { method: "POST", path: "/admin/content" },
      authorizer: { jwt: { claims: staff ? { "cognito:groups": ["staff"] } : {} } },
    },
  };
}

const createBody = {
  title: "Buzzer Beater!",
  channelId: "ch-niltv",
  athleteId: "ath-camila",
  description: "Last-second three.",
  rightsConfirmed: false,
};

describe("POST /admin/content — create", () => {
  beforeEach(() => {
    sendMock.mockReset();
    process.env.TABLE_NAME = "niltv-test";
  });

  it("assigns c-{slug}-{4 hex} and starts the row at uploading/hls", async () => {
    sendMock.mockResolvedValueOnce({});

    const res = await invoke(upsertEvent(createBody));

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body ?? "");
    expect(body.id).toMatch(/^c-buzzer-beater-[0-9a-f]{4}$/);
    expect(body).toMatchObject({
      title: "Buzzer Beater!",
      channelId: "ch-niltv",
      athleteId: "ath-camila",
      description: "Last-second three.",
      transcodeStatus: "uploading",
      provider: "hls",
      rightsConfirmed: false,
      likes: 0,
      views: 0,
    });

    const put = (sendMock.mock.calls[0]?.[0] as { input: Record<string, any> }).input;
    expect(put["Item"]).toMatchObject({
      PK: `CONTENT#${body.id}`,
      SK: "META",
      transcodeStatus: "uploading",
      provider: "hls",
    });
    // Never indexed at creation: only publish materializes the GSI rows.
    expect(put["Item"].GSI1PK).toBeUndefined();
    expect(put["ConditionExpression"]).toBe("attribute_not_exists(PK)");
  });

  it("400 on a body that fails the contract schema", async () => {
    const res = await invoke(upsertEvent({ channelId: "ch-niltv" })); // no title/athleteId
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body ?? "").error).toBe("BAD_REQUEST");
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("400 on unparseable JSON", async () => {
    const res = await invoke(upsertEvent("{not json"));
    expect(res.statusCode).toBe(400);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("403 without the staff group", async () => {
    const res = await invoke(upsertEvent(createBody, false));
    expect(res.statusCode).toBe(403);
    expect(sendMock).not.toHaveBeenCalled();
  });
});

describe("POST /admin/content — update (id present)", () => {
  beforeEach(() => {
    sendMock.mockReset();
    process.env.TABLE_NAME = "niltv-test";
  });

  const updateBody = { ...createBody, id: "c-buzzer-beater-abcd", rightsConfirmed: true };

  it("updates ONLY the five staff-editable fields, never pipeline state", async () => {
    // [0] GetCommand: the current row (content foundation: overrides are
    // recorded only for fields whose value changes).
    sendMock.mockResolvedValueOnce({ Item: { PK: "CONTENT#c-buzzer-beater-abcd", SK: "META", id: "c-buzzer-beater-abcd", ...createBody, rightsConfirmed: false, transcodeStatus: "ready" } });
    sendMock.mockResolvedValueOnce({
      Attributes: {
        PK: "CONTENT#c-buzzer-beater-abcd",
        SK: "META",
        id: "c-buzzer-beater-abcd",
        ...createBody,
        rightsConfirmed: true,
        transcodeStatus: "ready", // pipeline-owned, untouched by the update
        provider: "hls",
        likes: 3,
        views: 40,
      },
    });

    const res = await invoke(upsertEvent(updateBody));

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body ?? "");
    expect(body).toMatchObject({
      id: "c-buzzer-beater-abcd",
      rightsConfirmed: true,
      transcodeStatus: "ready",
      likes: 3,
    });

    const update = (sendMock.mock.calls[1]?.[0] as { input: Record<string, any> }).input;
    expect(update["Key"]).toEqual({ PK: "CONTENT#c-buzzer-beater-abcd", SK: "META" });
    expect(update["ConditionExpression"]).toBe("attribute_exists(PK)");
    // Exactly the five updatable fields — nothing else may ride along.
    expect(Object.keys(update["ExpressionAttributeValues"]).sort()).toEqual([
      ":athleteId",
      ":channelId",
      ":description",
      ":rightsConfirmed",
      ":title",
    ]);
    expect(update["UpdateExpression"]).not.toContain("transcodeStatus");
    expect(update["UpdateExpression"]).not.toContain("publishedAt");
    expect(update["UpdateExpression"]).not.toContain("playbackPath");
  });

  it("404 when the id does not exist (update never creates)", async () => {
    // The read-first flow: no row → 404 before any write is attempted.
    sendMock.mockResolvedValueOnce({ Item: undefined });

    const res = await invoke(upsertEvent(updateBody));
    expect(res.statusCode).toBe(404);
  });
});
