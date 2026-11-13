import { describe, expect, it } from "vitest";

import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  MeResponse,
  NotificationPreferences,
  NotificationPreferencesPutRequest,
  User,
} from "@niltv/types";

const meResponse = {
  userId: "u-1",
  name: "Test Fan",
  email: "fan@example.com",
  role: "fan",
  is18plus: true,
  pushEnabled: true,
  votes: {},
  follows: ["ath-test"],
  likes: [],
  notificationFollows: [{ targetType: "channel", targetId: "ch-test" }],
} as const;

describe("shared notification preference schemas", () => {
  it("defines the three stable category keys and legacy defaults", () => {
    expect(NotificationPreferences.parse(DEFAULT_NOTIFICATION_PREFERENCES)).toEqual({
      newVideosFromFollowedTargets: true,
      competitionsAndVoting: true,
      niltvAnnouncements: false,
    });
  });

  it("defaults missing legacy response preferences without changing other account fields", () => {
    const parsed = MeResponse.parse(meResponse);
    expect(parsed.notificationPreferences).toEqual(DEFAULT_NOTIFICATION_PREFERENCES);
    expect(parsed.pushEnabled).toBe(true);
    expect(parsed.follows).toEqual(["ath-test"]);
    expect(parsed.notificationFollows).toEqual([{ targetType: "channel", targetId: "ch-test" }]);
  });

  it("accepts a complete PUT payload and rejects missing or non-boolean categories", () => {
    const notificationPreferences = {
      newVideosFromFollowedTargets: false,
      competitionsAndVoting: true,
      niltvAnnouncements: true,
    };
    expect(
      NotificationPreferencesPutRequest.parse({ notificationPreferences }),
    ).toEqual({ notificationPreferences });
    expect(
      NotificationPreferencesPutRequest.safeParse({
        notificationPreferences: { newVideosFromFollowedTargets: true },
      }).success,
    ).toBe(false);
    expect(
      NotificationPreferencesPutRequest.safeParse({
        notificationPreferences: { ...notificationPreferences, niltvAnnouncements: "yes" },
      }).success,
    ).toBe(false);
  });

  it("keeps the preference field optional for legacy stored users and push off by default", () => {
    const user = User.parse({
      id: "u-1",
      name: "Test Fan",
      email: "fan@example.com",
      is18plus: true,
      createdAt: "2026-01-01T00:00:00Z",
    });
    expect(user.notificationPreferences).toBeUndefined();
    expect(user.pushEnabled).toBe(false);
  });
});
