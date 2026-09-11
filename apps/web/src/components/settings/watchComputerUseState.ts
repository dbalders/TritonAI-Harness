import type { DesktopComputerUseState } from "@t3tools/contracts";

/** Observe permission changes during setup without prompting or overlapping native reads. */
export function watchComputerUseState(input: {
  read: () => Promise<DesktopComputerUseState>;
  onState: (state: DesktopComputerUseState) => void;
  onError: (cause: unknown) => void;
}) {
  let stopped = false;
  let inFlight = false;
  let waitingForPermissions = true;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const refresh = async () => {
    if (stopped || inFlight) return;
    clearTimeout(timer);
    inFlight = true;
    try {
      const state = await input.read();
      if (stopped) return;
      waitingForPermissions =
        state.enabled &&
        state.available &&
        (state.accessibilityPermission === false || state.screenRecordingPermission === false);
      input.onState(state);
    } catch (cause) {
      if (!stopped) input.onError(cause);
    } finally {
      inFlight = false;
      if (!stopped && waitingForPermissions && document.visibilityState === "visible") {
        timer = setTimeout(() => void refresh(), 1_000);
      }
    }
  };

  const onVisibilityChange = () => {
    clearTimeout(timer);
    if (document.visibilityState === "visible") void refresh();
  };
  const onFocus = () => void refresh();
  window.addEventListener("focus", onFocus);
  document.addEventListener("visibilitychange", onVisibilityChange);
  void refresh();

  return {
    refresh,
    stop: () => {
      stopped = true;
      clearTimeout(timer);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    },
  };
}
