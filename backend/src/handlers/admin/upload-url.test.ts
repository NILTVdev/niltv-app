import { beforeEach, describe, expect, it, vi } from "vitest";

const getSignedUrlMock = vi.hoisted(() => vi.fn());

vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: getSignedUrlMock,
}));

import { handler, masterKey } from "./upload-url";

async function invoke(event: Record<string, unknown>) {
  const result = await handler(event as never, {} as never, () => undefined);
  if (result === undefined || typeof result === "string") {
    throw new Error("expected a structured APIGatewayProxyStructuredResultV2");
  }
  return result;
}

function uploadUrlEvent(opts: { id?: string; body?: unknown; staff?: boolean } = {}) {
  const { id = "c-dunk-a1b2", body, staff = true } = opts;
  return {
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    pathParameters: { id },
    requestContext: {
      http: { method: "POST", path: `/admin/content/${id}/upload-url` },
      authorizer: { jwt: { claims: staff ? { "cognito:groups": "[staff]" } : {} } },
    },
  };
}

describe("POST /admin/content/{id}/upload-url", () => {
  beforeEach(() => {
    getSignedUrlMock.mockReset();
    getSignedUrlMock.mockResolvedValue("https://masters.example/signed-put");
    process.env.MASTERS_BUCKET = "niltv-test-video-masters";
  });

  it("presigns a PUT for masters/{id}/master.mp4 with a 1h expiry", async () => {
    const res = await invoke(uploadUrlEvent());

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body ?? "")).toEqual({
      uploadUrl: "https://masters.example/signed-put",
      key: "masters/c-dunk-a1b2/master.mp4",
      expiresInSeconds: 3600,
    });

    const [, command, options] = getSignedUrlMock.mock.calls[0] ?? [];
    expect(command.input).toMatchObject({
      Bucket: "niltv-test-video-masters",
      Key: "masters/c-dunk-a1b2/master.mp4",
      ContentType: "video/mp4", // default when no body is sent
    });
    expect(options).toEqual({ expiresIn: 3600 });
  });

  it("passes a caller-supplied contentType through to the signed PUT", async () => {
    const res = await invoke(uploadUrlEvent({ body: { contentType: "video/quicktime" } }));

    expect(res.statusCode).toBe(200);
    const [, command] = getSignedUrlMock.mock.calls[0] ?? [];
    expect(command.input.ContentType).toBe("video/quicktime");
    // The key shape never varies with content type — start-transcode parses
    // masters/{contentId}/{filename}, and re-uploads overwrite in place.
    expect(command.input.Key).toBe("masters/c-dunk-a1b2/master.mp4");
  });

  it("key shape matches start-transcode's masters/{contentId}/{filename} contract", () => {
    expect(masterKey("c-x-1234")).toBe("masters/c-x-1234/master.mp4");
    expect(masterKey("c-x-1234").split("/")).toHaveLength(3);
  });

  it("404 without a content id in the path", async () => {
    const res = await invoke({ ...uploadUrlEvent(), pathParameters: {} });
    expect(res.statusCode).toBe(404);
    expect(getSignedUrlMock).not.toHaveBeenCalled();
  });

  it("403 without the staff group — nothing is signed", async () => {
    const res = await invoke(uploadUrlEvent({ staff: false }));
    expect(res.statusCode).toBe(403);
    expect(getSignedUrlMock).not.toHaveBeenCalled();
  });
});
