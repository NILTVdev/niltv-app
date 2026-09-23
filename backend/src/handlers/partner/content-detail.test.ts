import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sendMock = vi.hoisted(() => vi.fn());

vi.mock("../../lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/db")>();
  return { ...actual, getDocClient: () => ({ send: sendMock }) };
});

vi.mock("../../lib/partner-signing", () => ({
  getPartnerSigner: async () => ({
    domain: "dl.test",
    sign: (path: string, expiresAt: Date) => `https://dl.test${path}?Expires=${expiresAt.getTime() / 1000}&Signature=x`,
  }),
}));

import { handler } from "./content-detail";

const partnerRow = (overrides: Record<string, unknown> = {}) => ({
  PK: "PARTNER#p-example",
  SK: "META",
  id: "p-example",
  name: "Example Network",
  status: "active",
  licence: { seriesIds: ["example-series"], channelIds: ["ch-trueblue"] },
  createdAt: "2026-09-01T00:00:00Z",
  webhookSecret: "never-returned",
  activeKeyHash: "never-returned",
  ...overrides,
});

const contentRow = (overrides: Record<string, unknown> = {}) => ({
  PK: "CONTENT#ig-1",
  SK: "META",
  id: "ig-1",
  title: "Preseason vibes 😓😴 #soccer #preseason #duke",
  description: "Preseason vibes 😓😴 #soccer #preseason #duke",
  channelId: "ch-trueblue",
  athleteId: "ath-a",
  transcodeStatus: "published",
  publishedAt: "2026-07-19T15:37:28Z",
  playbackPath: "/video/ig-1/master.mp4",
  thumbPath: "/video/ig-1/poster.jpg",
  duration: 6,
  rights: { status: "licensed", logoCleared: true, music: "none" },
  ...overrides,
});

const channelItem = { PK: "CHANNEL#ch-trueblue", SK: "META", id: "ch-trueblue", name: "TrueBlueTV", kind: "trueblue" };
const profileItem = { PK: "ATHLETE#ath-a", SK: "META", id: "ath-a", name: "Ava Duke", school: "Duke", sport: "Soccer" };

const invoke = (id = "ig-1") =>
  handler({
    pathParameters: { id },
    requestContext: { authorizer: { lambda: { partnerId: "p-example" } }, http: { path: `/partner/v1/content/${id}` } },
    headers: {},
  } as never);

describe("GET /partner/v1/content/{id}", () => {
  beforeEach(() => {
    sendMock.mockReset();
    process.env.TABLE_NAME = "niltv-test";
    process.env.PARTNER_API_ENABLED = "true";
    process.env.SITE_ORIGIN = "https://niltv.com";
    delete process.env.ORIGIN_VERIFY_SECRET;
  });
  afterEach(() => {
    delete process.env.PARTNER_API_ENABLED;
  });

  it("returns the asset with signed URLs and a cleaned title", async () => {
    sendMock
      .mockResolvedValueOnce({ Item: partnerRow() }) // loadPartner
      .mockResolvedValueOnce({ Item: contentRow() }) // content
      .mockResolvedValueOnce({ Responses: { "niltv-test": [channelItem, profileItem] } }); // lookups
    const result = await invoke();
    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body ?? "{}");
    expect(body.title).toBe("Preseason vibes");
    expect(body.credit).toBe("Ava Duke, Duke / NIL TV");
    expect(body.canonicalUrl).toBe("https://niltv.com/watch/ig-1/");
    expect(body.files.mp4.url).toMatch(/^https:\/\/dl\.test\/ig-1\/master\.mp4\?Expires=\d+&Signature=x$/);
    expect(body.files.poster.url).toContain("/ig-1/poster.jpg");
    expect(body.status).toBe("published");
    expect(JSON.stringify(body)).not.toContain("never-returned");
  });

  it("answers 404, not 403, for a row outside the partner's licence", async () => {
    sendMock
      .mockResolvedValueOnce({ Item: partnerRow({ licence: { seriesIds: [], channelIds: ["ch-other"] } }) })
      .mockResolvedValueOnce({ Item: contentRow() })
      .mockResolvedValueOnce({ Responses: { "niltv-test": [channelItem, profileItem] } });
    const result = await invoke();
    expect(result.statusCode).toBe(404);
  });

  it("answers 404 for a withdrawn row and for platform-library music", async () => {
    sendMock
      .mockResolvedValueOnce({ Item: partnerRow() })
      .mockResolvedValueOnce({ Item: contentRow({ withdrawnAt: "2026-09-02T00:00:00Z" }) })
      .mockResolvedValueOnce({ Responses: { "niltv-test": [channelItem, profileItem] } });
    expect((await invoke()).statusCode).toBe(404);

    sendMock.mockReset();
    sendMock
      .mockResolvedValueOnce({ Item: partnerRow() })
      .mockResolvedValueOnce({ Item: contentRow({ rights: { status: "licensed", logoCleared: true, music: "platform" } }) })
      .mockResolvedValueOnce({ Responses: { "niltv-test": [channelItem, profileItem] } });
    expect((await invoke()).statusCode).toBe(404);
  });

  it("is a 404 everywhere when the stage kill switch is off", async () => {
    process.env.PARTNER_API_ENABLED = "false";
    const result = await invoke();
    expect(result.statusCode).toBe(404);
    expect(sendMock).not.toHaveBeenCalled();
  });
});
