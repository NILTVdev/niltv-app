import { beforeEach, describe, expect, it, vi } from "vitest";

const sendMock = vi.hoisted(() => vi.fn());

vi.mock("../../lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/db")>();
  return {
    ...actual,
    getDocClient: () => ({ send: sendMock }),
  };
});

import { handler } from "./publish";

async function invoke(event: Record<string, unknown>) {
  const result = await handler(event as never, {} as never, () => undefined);
  if (result === undefined || typeof result === "string") {
    throw new Error("expected a structured APIGatewayProxyStructuredResultV2");
  }
  return result;
}

function publishEvent(action: "publish" | "unpublish", opts: { staff?: boolean; id?: string } = {}) {
  const { staff = true, id = "c-dunk-a1b2" } = opts;
  return {
    rawPath: `/admin/content/${id}/${action}`,
    pathParameters: { id },
    requestContext: {
      http: { method: "POST", path: `/admin/content/${id}/${action}` },
      authorizer: { jwt: { claims: staff ? { "cognito:groups": "[staff]" } : {} } },
    },
  };
}

/** A content row snapshot; override the gate fields per test. */
function contentRow(overrides: Record<string, unknown> = {}) {
  return {
    PK: "CONTENT#c-dunk-a1b2",
    SK: "META",
    id: "c-dunk-a1b2",
    title: "Dunk",
    channelId: "ch-niltv",
    athleteId: "ath-camila",
    transcodeStatus: "ready",
    rightsConfirmed: true,
    ...overrides,
  };
}

function conditionalCheckFailed() {
  return Object.assign(new Error("The conditional request failed"), {
    name: "ConditionalCheckFailedException",
  });
}

describe("POST /admin/content/{id}/publish — the §6.8 gate", () => {
  beforeEach(() => {
    sendMock.mockReset();
    process.env.TABLE_NAME = "niltv-test";
  });

  it("publishes a ready + rights-confirmed row: condition, GSI keys, publishedAt", async () => {
    sendMock
      .mockResolvedValueOnce({ Item: contentRow() }) // pre-read
      .mockResolvedValueOnce({}); // conditional update

    const res = await invoke(publishEvent("publish"));

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body ?? "");
    expect(body.status).toBe("published");
    expect(typeof body.publishedAt).toBe("string");

    const update = (sendMock.mock.calls[1]?.[0] as { input: Record<string, any> }).input;
    expect(update["ConditionExpression"]).toBe(
      "#transcodeStatus = :ready AND #rightsConfirmed = :confirmed",
    );
    expect(update["ExpressionAttributeValues"]).toMatchObject({
      ":ready": "ready",
      ":confirmed": true,
      ":published": "published",
      ":publishedAt": body.publishedAt,
      ":gsi1pk": "CHANNEL#ch-niltv",
      ":gsi2pk": "ATHLETE#ath-camila",
    });
    expect(update["UpdateExpression"]).toContain("GSI1PK = :gsi1pk");
    expect(update["UpdateExpression"]).toContain("GSI1SK = :publishedAt");
    expect(update["UpdateExpression"]).toContain("GSI2PK = :gsi2pk");
    expect(update["UpdateExpression"]).toContain("GSI2SK = :publishedAt");
  });

  it("409 NOT_READY when the transcode is not ready — message names the status", async () => {
    sendMock
      .mockResolvedValueOnce({ Item: contentRow({ transcodeStatus: "processing" }) })
      .mockRejectedValueOnce(conditionalCheckFailed());

    const res = await invoke(publishEvent("publish"));

    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body ?? "");
    expect(body.error).toBe("NOT_READY");
    expect(body.message).toContain("transcode is not ready");
    expect(body.message).toContain("processing");
    expect(body.message).not.toContain("rightsConfirmed");
  });

  it("409 NOT_READY when rights are not confirmed — message names the rights gate", async () => {
    sendMock
      .mockResolvedValueOnce({ Item: contentRow({ rightsConfirmed: false }) })
      .mockRejectedValueOnce(conditionalCheckFailed());

    const res = await invoke(publishEvent("publish"));

    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body ?? "");
    expect(body.error).toBe("NOT_READY");
    expect(body.message).toContain("rightsConfirmed");
    expect(body.message).not.toContain("transcode is not ready");
  });

  it("409 lists BOTH failed preconditions when neither holds", async () => {
    sendMock
      .mockResolvedValueOnce({
        Item: contentRow({ transcodeStatus: "uploading", rightsConfirmed: false }),
      })
      .mockRejectedValueOnce(conditionalCheckFailed());

    const res = await invoke(publishEvent("publish"));

    const body = JSON.parse(res.body ?? "");
    expect(res.statusCode).toBe(409);
    expect(body.message).toContain("transcode is not ready");
    expect(body.message).toContain("rightsConfirmed");
  });

  it("409 flags an already-published row distinctly", async () => {
    sendMock
      .mockResolvedValueOnce({
        Item: contentRow({ transcodeStatus: "published", publishedAt: "2026-07-01T00:00:00Z" }),
      })
      .mockRejectedValueOnce(conditionalCheckFailed());

    const res = await invoke(publishEvent("publish"));
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body ?? "").message).toContain("already published");
  });

  it("404 when the content row does not exist", async () => {
    sendMock.mockResolvedValueOnce({});
    const res = await invoke(publishEvent("publish"));
    expect(res.statusCode).toBe(404);
    expect(sendMock).toHaveBeenCalledTimes(1); // read only, no update attempted
  });

  it("403 FORBIDDEN for a valid JWT without the staff group — before any DB call", async () => {
    const res = await invoke(publishEvent("publish", { staff: false }));
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body ?? "")).toEqual({ error: "FORBIDDEN" });
    expect(sendMock).not.toHaveBeenCalled();
  });
});

describe("POST /admin/content/{id}/unpublish", () => {
  beforeEach(() => {
    sendMock.mockReset();
    process.env.TABLE_NAME = "niltv-test";
  });

  it("removes publishedAt + all six GSI attrs (incl. the syndication index) and restores transcodeStatus ready", async () => {
    sendMock
      .mockResolvedValueOnce({
        Item: contentRow({ transcodeStatus: "published", publishedAt: "2026-07-01T00:00:00Z" }),
      })
      .mockResolvedValueOnce({});

    const res = await invoke(publishEvent("unpublish"));

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body ?? "")).toEqual({ status: "unpublished" });

    const update = (sendMock.mock.calls[1]?.[0] as { input: Record<string, any> }).input;
    expect(update["ConditionExpression"]).toBe("#transcodeStatus = :published");
    expect(update["UpdateExpression"]).toBe(
      "SET #transcodeStatus = :ready REMOVE #publishedAt, GSI1PK, GSI1SK, GSI2PK, GSI2SK, GSI3PK, GSI3SK",
    );
    expect(update["ExpressionAttributeValues"]).toEqual({
      ":published": "published",
      ":ready": "ready",
    });
  });

  it("409 when the row is not published (never promotes a pipeline state)", async () => {
    sendMock
      .mockResolvedValueOnce({ Item: contentRow({ transcodeStatus: "processing" }) })
      .mockRejectedValueOnce(conditionalCheckFailed());

    const res = await invoke(publishEvent("unpublish"));

    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body ?? "");
    expect(body.error).toBe("NOT_READY");
    expect(body.message).toContain("not published");
    expect(body.message).toContain("processing");
  });
});
