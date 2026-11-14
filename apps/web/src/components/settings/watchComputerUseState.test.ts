import { type DesktopComputerUseState } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { watchComputerUseState } from "./watchComputerUseState";

const missing: DesktopComputerUseState = {
  enabled: true,
  available: true,
  running: false,
  accessibilityPermission: false,
  screenRecordingPermission: true,
};
const granted = { ...missing, accessibilityPermission: true };

describe("computer-use permission observation", () => {
  let documentTarget: EventTarget & { visibilityState: string };
  let windowTarget: EventTarget;
  let observer: ReturnType<typeof watchComputerUseState> | undefined;
  const onState = vi.fn<(state: DesktopComputerUseState) => void>();
  const onError = vi.fn();

  function watch(read: () => Promise<DesktopComputerUseState>) {
    observer = watchComputerUseState({ read, onState, onError });
    return observer;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    documentTarget = Object.assign(new EventTarget(), { visibilityState: "visible" });
    windowTarget = new EventTarget();
    vi.stubGlobal("document", documentTarget);
    vi.stubGlobal("window", windowTarget);
  });
  afterEach(() => {
    observer?.stop();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  // regression: #215 fix(desktop): make computer-use setup and activity visible
  it.each([
    { ...missing, enabled: false },
    { ...missing, available: false },
    { ...granted, running: true },
    { ...missing, accessibilityPermission: null, screenRecordingPermission: null },
  ])("does not keep polling when permission setup is unnecessary: %j", async (state) => {
    const read = vi.fn().mockResolvedValue(state);
    watch(read);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(onState).toHaveBeenLastCalledWith(state);
    expect(read).toHaveBeenCalledTimes(1);
  });
});
