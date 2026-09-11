import type { DesktopComputerUseState } from "./ipc.ts";

export function describeComputerUseReadiness(state: DesktopComputerUseState): {
  ready: boolean;
  label: string;
  detail: string;
} {
  if (!state.available)
    return {
      ready: false,
      label: "Unavailable",
      detail:
        "Computer use is not included in this desktop build. Install or repair TritonAI Harness.",
    };
  if (!state.enabled)
    return {
      ready: false,
      label: "Off",
      detail:
        "Turn on Computer use in Settings > General to let the agent see and control desktop apps.",
    };
  const missing = [
    state.accessibilityPermission === false ? "Accessibility" : null,
    state.screenRecordingPermission === false ? "Screen Recording" : null,
  ].filter((permission) => permission !== null);
  if (missing.length)
    return {
      ready: false,
      label: "Needs permissions",
      detail: `Allow ${missing.join(" and ")} in System Settings, then return here and restart TritonAI Harness.`,
    };
  if (!state.running)
    return {
      ready: false,
      label: "Restart required",
      detail:
        "Permissions are ready. Restart TritonAI Harness to connect computer use. If it still cannot connect, check desktop diagnostics.",
    };
  return {
    ready: true,
    label: "Ready",
    detail: "The agent can see and control desktop apps on this computer.",
  };
}
