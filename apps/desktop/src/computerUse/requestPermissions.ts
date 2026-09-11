import type { MacOSPermissionStatus } from "@trycua/cua-driver/electron";

/** Only called after an explicit opt-in or permission retry, never on startup. */
export async function requestComputerUsePermissions(input: {
  requestNativePermissions: () => MacOSPermissionStatus;
  requestScreenCapture: () => Promise<unknown>;
  readPermissions: () => MacOSPermissionStatus;
}): Promise<MacOSPermissionStatus> {
  const status = input.requestNativePermissions();
  if (!status.screenRecording) {
    // Request from Electron itself so macOS registers the host application.
    // The SDK request alone can leave it absent from the Screen Recording list.
    try {
      await input.requestScreenCapture();
    } catch {
      // A declined capture is a permission state, not a failed settings save.
      // The caller opens System Settings if access is still missing.
    }
  }
  return input.readPermissions();
}
