import { describe, expect, it, vi } from "vite-plus/test";
import { requestComputerUsePermissions } from "./requestPermissions.ts";

describe("computer use permission onboarding", () => {
  // regression: #215 fix(desktop): make computer-use setup and activity visible
  it("requests screen capture when the SDK only grants Accessibility", async () => {
    let granted = false;
    const requestScreenCapture = vi.fn(async () => {
      granted = true;
    });
    const status = await requestComputerUsePermissions({
      requestNativePermissions: () => ({ accessibility: true, screenRecording: false }),
      requestScreenCapture,
      readPermissions: () => ({ accessibility: true, screenRecording: granted }),
    });
    expect(requestScreenCapture).toHaveBeenCalledOnce();
    expect(status).toEqual({ accessibility: true, screenRecording: true });
  });

  // regression: #215 fix(desktop): make computer-use setup and activity visible
  it("keeps a denied capture actionable without failing opt-in", async () => {
    const status = await requestComputerUsePermissions({
      requestNativePermissions: () => ({ accessibility: true, screenRecording: false }),
      requestScreenCapture: async () => {
        throw new Error("Permission denied");
      },
      readPermissions: () => ({ accessibility: true, screenRecording: false }),
    });
    expect(status.screenRecording).toBe(false);
  });

  // regression: #215 fix(desktop): make computer-use setup and activity visible
  it("does not capture the screen when access is already granted", async () => {
    const requestScreenCapture = vi.fn();
    await requestComputerUsePermissions({
      requestNativePermissions: () => ({ accessibility: true, screenRecording: true }),
      requestScreenCapture,
      readPermissions: () => ({ accessibility: true, screenRecording: true }),
    });
    expect(requestScreenCapture).not.toHaveBeenCalled();
  });
});
