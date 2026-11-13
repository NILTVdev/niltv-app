import { beforeEach, describe, expect, it, vi } from "vitest";

import { refreshRegistrationIfGranted, requestAndRegister } from "./index";

const mocks = vi.hoisted(() => ({
  getPermissionsAsync: vi.fn(),
  requestPermissionsAsync: vi.fn(),
  getExpoPushTokenAsync: vi.fn(),
  request: vi.fn(),
  setQueryData: vi.fn(),
  track: vi.fn(),
}));

vi.mock("expo-constants", () => ({
  default: { expoConfig: { extra: { eas: { projectId: "test-project" } } } },
}));
vi.mock("expo-device", () => ({ isDevice: true }));
vi.mock("expo-notifications", () => ({
  setNotificationHandler: vi.fn(),
  getPermissionsAsync: mocks.getPermissionsAsync,
  requestPermissionsAsync: mocks.requestPermissionsAsync,
  getExpoPushTokenAsync: mocks.getExpoPushTokenAsync,
}));
vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));
vi.mock("@/api/client", () => ({ request: mocks.request }));
vi.mock("@/api/keys", () => ({ queryKeys: { me: ["me"] } }));
vi.mock("@/api/queryClient", () => ({
  queryClient: { setQueryData: mocks.setQueryData },
}));
vi.mock("@/telemetry", () => ({ track: mocks.track }));

describe("push registration intent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getPermissionsAsync.mockResolvedValue({ granted: true, canAskAgain: false });
    mocks.requestPermissionsAsync.mockResolvedValue({ granted: true, canAskAgain: false });
    mocks.getExpoPushTokenAsync.mockResolvedValue({ data: "ExponentPushToken[test]" });
    mocks.request.mockResolvedValue({ status: "ok" });
    mocks.setQueryData.mockImplementation((_key, update) =>
      update({ userId: "u-test", pushEnabled: false }),
    );
  });

  it("sends an explicit opt-in only after a user-triggered permission grant", async () => {
    mocks.getPermissionsAsync.mockResolvedValueOnce({ granted: false, canAskAgain: true });

    await expect(requestAndRegister()).resolves.toBe("granted");

    expect(mocks.requestPermissionsAsync).toHaveBeenCalledOnce();
    expect(mocks.request).toHaveBeenCalledWith(
      "/v1/me/devices",
      expect.anything(),
      expect.objectContaining({
        method: "POST",
        body: {
          expoPushToken: "ExponentPushToken[test]",
          platform: "ios",
          optIn: true,
        },
      }),
    );
    expect(mocks.setQueryData).toHaveBeenCalledOnce();
  });

  it("silently refreshes a granted token without opting back in", async () => {
    await refreshRegistrationIfGranted();

    expect(mocks.requestPermissionsAsync).not.toHaveBeenCalled();
    expect(mocks.request).toHaveBeenCalledWith(
      "/v1/me/devices",
      expect.anything(),
      expect.objectContaining({
        method: "POST",
        body: {
          expoPushToken: "ExponentPushToken[test]",
          platform: "ios",
        },
      }),
    );
    expect(mocks.setQueryData).not.toHaveBeenCalled();
  });

  it("does not register or opt in when the OS permission is denied", async () => {
    mocks.getPermissionsAsync.mockResolvedValueOnce({ granted: false, canAskAgain: false });

    await expect(requestAndRegister()).resolves.toBe("denied");

    expect(mocks.request).not.toHaveBeenCalled();
    expect(mocks.setQueryData).not.toHaveBeenCalled();
  });
});
