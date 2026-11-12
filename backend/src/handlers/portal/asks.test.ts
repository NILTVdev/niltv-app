import { NotifyPrefs, type PortalMember } from "@niltv/types";
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2, Context } from "aws-lambda";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ db: vi.fn(), s3: vi.fn(), authorize: vi.fn() }));

vi.mock("../../lib/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/db")>()),
  getDocClient: () => ({ send: m.db }),
}));
vi.mock("../../lib/portal/access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/portal/access")>()),
  authorize: m.authorize,
}));
vi.mock("@aws-sdk/client-s3", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@aws-sdk/client-s3")>()),
  S3Client: class {
    send = m.s3;
  },
}));

import { MAX_OPEN_UPLOADS } from "../../lib/portal/hub";
import { handler } from "./asks";

type Cmd = { constructor: { name: string }; input: Record<string, any> };

const athlete: PortalMember = {
  sub: "u-1",
  email: "a@example.com",
  name: "Jordan M.",
  role: "athlete",
  status: "active",
  desks: [],
  edited: [],
  notify: NotifyPrefs.parse({}),
  createdAt: "2026-10-01T00:00:00.000Z",
};

const uploading = (i: number) => ({
  PK: "ASK#ask-1",
  SK: `FILE#u-1#file-${i}`,
  sub: "u-1",
  id: `file-${i}`,
  name: `clip-${i}.mp4`,
  size: 1000,
  type: "video/mp4",
  key: `submissions/ask-1/u-1/file-${i}/clip-${i}.mp4`,
  uploadId: `up-${i}`,
  state: "uploading",
  at: "2026-11-10T00:00:00.000Z",
});

/** A claimed ask whose caller already holds `open` unfinished uploads. */
function table(open: number): void {
  m.db.mockImplementation(async (cmd: Cmd) => {
    if (cmd.constructor.name === "GetCommand") return { Item: { sub: "u-1", status: "claimed", at: "2026-11-09T00:00:00.000Z" } };
    if (cmd.constructor.name === "QueryCommand") return { Items: Array.from({ length: open }, (_, i) => uploading(i)) };
    return {};
  });
}

const start = () =>
  handler(
    {
      routeKey: "POST /v1/asks/{id}/uploads",
      pathParameters: { id: "ask-1" },
      body: JSON.stringify({ name: "new.mp4", size: 5000, type: "video/mp4" }),
    } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer,
    {} as Context,
    () => {},
  ) as Promise<APIGatewayProxyStructuredResultV2>;

beforeEach(() => {
  m.db.mockReset();
  m.s3.mockReset();
  m.authorize.mockResolvedValue({ caller: { sub: "u-1", member: athlete } });
  m.s3.mockResolvedValue({ UploadId: "up-new" });
  process.env.TABLE_NAME = "niltv-test";
  process.env.SUBMISSIONS_BUCKET = "bucket";
});

describe("starting an upload", () => {
  it("refuses a new upload once the athlete holds the cap of unfinished ones on that ask", async () => {
    table(MAX_OPEN_UPLOADS);
    const res = await start();
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(String(res.body)).error).toBe("TOO_MANY_UPLOADS");
    expect(m.s3).not.toHaveBeenCalled();
  });

  it("starts one below the cap", async () => {
    table(MAX_OPEN_UPLOADS - 1);
    const res = await start();
    expect(res.statusCode).toBe(201);
    expect((m.s3.mock.calls[0]![0] as Cmd).constructor.name).toBe("CreateMultipartUploadCommand");
  });
});
