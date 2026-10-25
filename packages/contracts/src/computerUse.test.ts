import { describe, expect, it } from "vite-plus/test";
import { describeComputerUseReadiness } from "./computerUse.ts";

const ready = {
  enabled: true,
  available: true,
  running: true,
  accessibilityPermission: true,
  screenRecordingPermission: true,
};

describe("computer use readiness", () => {
  // regression: #215 fix(desktop): make computer-use setup and activity visible
  it("names just the missing grant, even if a driver was previously running", () => {
    const status = describeComputerUseReadiness({ ...ready, screenRecordingPermission: false });
    expect(status.ready).toBe(false);
    expect(status.label).toBe("Needs permissions");
    expect(status.detail).toContain("Allow Screen Recording");
    expect(status.detail).not.toContain("Accessibility");
  });
  // regression: #215 fix(desktop): make computer-use setup and activity visible
  it("distinguishes opt-in, permissions, and an actual connection", () => {
    expect(describeComputerUseReadiness({ ...ready, enabled: false }).label).toBe("Off");
    expect(describeComputerUseReadiness({ ...ready, running: false }).label).toBe(
      "Restart required",
    );
    expect(describeComputerUseReadiness(ready).ready).toBe(true);
    expect(describeComputerUseReadiness({ ...ready, available: false }).ready).toBe(false);
  });
  // regression: #215 fix(desktop): make computer-use setup and activity visible
  it("allows platforms without macOS grants", () => {
    expect(
      describeComputerUseReadiness({
        ...ready,
        accessibilityPermission: null,
        screenRecordingPermission: null,
      }).ready,
    ).toBe(true);
  });
});
