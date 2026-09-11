import { describeComputerUseReadiness, type DesktopComputerUseState } from "@t3tools/contracts";
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

  it("detects a grant without a focus event and stops polling once a restart is all that remains", async () => {
    const read = vi.fn().mockResolvedValueOnce(missing).mockResolvedValue(granted);
    watch(read);
    await vi.advanceTimersByTimeAsync(0);
    expect(onState).toHaveBeenLastCalledWith(missing);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(onState).toHaveBeenLastCalledWith(granted);
    expect(describeComputerUseReadiness(granted).label).toBe("Restart required");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(read).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("refreshes immediately on focus and detects revoked access after setup", async () => {
    const read = vi.fn().mockResolvedValueOnce(granted).mockResolvedValue(missing);
    watch(read);
    await vi.advanceTimersByTimeAsync(0);
    windowTarget.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(0);
    expect(onState).toHaveBeenLastCalledWith(missing);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(read).toHaveBeenCalledTimes(3);
  });

  it("pauses while hidden and immediately catches up when the panel is visible", async () => {
    const read = vi.fn().mockResolvedValue(missing);
    watch(read);
    await vi.advanceTimersByTimeAsync(0);
    documentTarget.visibilityState = "hidden";
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(read).toHaveBeenCalledTimes(1);
    read.mockResolvedValue(granted);
    documentTarget.visibilityState = "visible";
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(onState).toHaveBeenLastCalledWith(granted);
  });

  it("serializes slow checks across timer, focus, and manual refresh requests", async () => {
    let finish!: (state: DesktopComputerUseState) => void;
    const read = vi.fn(() => new Promise<DesktopComputerUseState>((resolve) => (finish = resolve)));
    const watcher = watch(read);
    windowTarget.dispatchEvent(new Event("focus"));
    await watcher.refresh();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(read).toHaveBeenCalledTimes(1);
    finish(missing);
    await vi.advanceTimersByTimeAsync(999);
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("ignores an old response after unmount or an opt-in change and removes listeners", async () => {
    let finish!: (state: DesktopComputerUseState) => void;
    const read = vi.fn(() => new Promise<DesktopComputerUseState>((resolve) => (finish = resolve)));
    watch(read).stop();
    finish(missing);
    await vi.advanceTimersByTimeAsync(5_000);
    windowTarget.dispatchEvent(new Event("focus"));
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    expect(onState).not.toHaveBeenCalled();
    expect(read).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

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

  it("recovers from a transient read failure during onboarding", async () => {
    const failure = new Error("IPC temporarily unavailable");
    const read = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue(granted);
    watch(read);
    await vi.advanceTimersByTimeAsync(0);
    expect(onError).toHaveBeenCalledWith(failure);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(onState).toHaveBeenLastCalledWith(granted);
    expect(vi.getTimerCount()).toBe(0);
  });
});
