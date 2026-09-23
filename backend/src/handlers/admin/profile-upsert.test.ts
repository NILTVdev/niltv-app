import { beforeEach, describe, expect, it, vi } from "vitest";

const sendMock = vi.hoisted(() => vi.fn());

vi.mock("../../lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/db")>();
  return {
    ...actual,
    getDocClient: () => ({ send: sendMock }),
  };
});

import { handler } from "./profile-upsert";

async function invoke(event: Record<string, unknown>) {
  const result = await handler(event as never, {} as never, () => undefined);
  if (result === undefined || typeof result === "string") {
    throw new Error("expected a structured APIGatewayProxyStructuredResultV2");
  }
  return result;
}

function upsertEvent(body: unknown, staff = true) {
  return {
    body: JSON.stringify(body),
    requestContext: {
      http: { method: "POST", path: "/admin/profiles" },
      authorizer: { jwt: { claims: staff ? { "cognito:groups": ["staff"] } : {} } },
    },
  };
}

describe("POST /admin/profiles — create", () => {
  beforeEach(() => {
    sendMock.mockReset();
    process.env.TABLE_NAME = "niltv-test";
  });

  it("derives ath-{slug(name)} and writes the rank-first directory GSI row", async () => {
    sendMock.mockResolvedValueOnce({});

    const res = await invoke(
      upsertEvent({
        name: "Camila Garza",
        handle: "camilag",
        school: "Duke",
        sport: "Soccer",
        ambassadorRank: 2,
      }),
    );

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body ?? "");
    expect(body).toMatchObject({
      id: "ath-camila-garza",
      statuses: ["athlete"], // zod default
      followers: 0,
      totalViews: 0,
      claimedBy: null,
    });

    const put = (sendMock.mock.calls[0]?.[0] as { input: Record<string, any> }).input;
    expect(put["Item"]).toMatchObject({
      PK: "ATHLETE#ath-camila-garza",
      SK: "META",
      GSI1PK: "PROFILES#ALL",
      GSI1SK: "02", // zero-padded rank, exactly like seed.ts
    });
    expect(put["ConditionExpression"]).toBe("attribute_not_exists(PK)");
  });

  it("unranked profiles sort by name in the directory GSI", async () => {
    sendMock.mockResolvedValueOnce({});
    await invoke(upsertEvent({ name: "Marcus Hall", handle: "mhall", school: "Duke", sport: "Hoops" }));
    const put = (sendMock.mock.calls[0]?.[0] as { input: Record<string, any> }).input;
    expect(put["Item"].GSI1SK).toBe("Marcus Hall");
  });

  it("409 CONFLICT when the derived id already exists", async () => {
    sendMock.mockRejectedValueOnce(
      Object.assign(new Error("The conditional request failed"), {
        name: "ConditionalCheckFailedException",
      }),
    );
    const res = await invoke(
      upsertEvent({ name: "Camila Garza", handle: "camilag", school: "Duke", sport: "Soccer" }),
    );
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body ?? "").error).toBe("CONFLICT");
  });
});

describe("POST /admin/profiles — update", () => {
  beforeEach(() => {
    sendMock.mockReset();
    process.env.TABLE_NAME = "niltv-test";
  });

  const existingRow = {
    PK: "ATHLETE#ath-camila-garza",
    SK: "META",
    GSI1PK: "PROFILES#ALL",
    GSI1SK: "02",
    id: "ath-camila-garza",
    name: "Camila Garza",
    handle: "camilag",
    school: "Duke",
    sport: "Soccer",
    bio: "Striker.",
    statuses: ["athlete", "ambassador"],
    ambassadorRank: 2,
    avatarUrl: "https://cdn/avatar.jpg",
    followers: 1234,
    totalViews: 56789,
    claimedBy: "u-9",
    socials: [],
    brands: ["Nike"],
  };

  it("preserves followers/totalViews/claimedBy (and media URLs) across an update", async () => {
    sendMock.mockResolvedValueOnce({ Item: existingRow }).mockResolvedValueOnce({});

    const res = await invoke(
      upsertEvent({
        id: "ath-camila-garza",
        name: "Camila Garza",
        handle: "camila",
        school: "Duke",
        sport: "Soccer",
        bio: "Striker and captain.",
        ambassadorRank: 1,
      }),
    );

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body ?? "");
    expect(body).toMatchObject({
      handle: "camila",
      bio: "Striker and captain.",
      ambassadorRank: 1,
      followers: 1234, // system-owned, preserved
      totalViews: 56789,
      claimedBy: "u-9",
      avatarUrl: "https://cdn/avatar.jpg",
      brands: ["Nike"], // omitted in the request → preserved
    });

    const put = (sendMock.mock.calls[1]?.[0] as { input: Record<string, any> }).input;
    expect(put["Item"]).toMatchObject({
      PK: "ATHLETE#ath-camila-garza",
      GSI1PK: "PROFILES#ALL",
      GSI1SK: "01", // GSI re-derived from the NEW rank
      followers: 1234,
    });
    expect(put["ConditionExpression"]).toBeUndefined();
  });

  it("clears the rank (and falls back to name ordering) when the update omits it", async () => {
    sendMock.mockResolvedValueOnce({ Item: existingRow }).mockResolvedValueOnce({});

    const res = await invoke(
      upsertEvent({
        id: "ath-camila-garza",
        name: "Camila Garza",
        handle: "camilag",
        school: "Duke",
        sport: "Soccer",
      }),
    );

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body ?? "").ambassadorRank).toBeUndefined();
    const put = (sendMock.mock.calls[1]?.[0] as { input: Record<string, any> }).input;
    expect(put["Item"].GSI1SK).toBe("Camila Garza");
    expect(put["Item"].ambassadorRank).toBeUndefined();
  });

  it("404 when the id does not exist", async () => {
    sendMock.mockResolvedValueOnce({});
    const res = await invoke(
      upsertEvent({ id: "ath-nobody", name: "No One", handle: "n1", school: "X", sport: "Y" }),
    );
    expect(res.statusCode).toBe(404);
    expect(sendMock).toHaveBeenCalledTimes(1);
  });
});
