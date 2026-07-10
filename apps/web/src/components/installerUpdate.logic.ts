import type { InstallerUpdateActionResult, InstallerUpdateState } from "@t3tools/contracts";

export type InstallerUpdateButtonAction = "open" | "check" | "none";

export function resolveInstallerUpdateButtonAction(
  state: InstallerUpdateState,
): InstallerUpdateButtonAction {
  if (!state.enabled) return "none";
  if (state.status === "available") return "open";
  if (state.status === "idle" || state.status === "up-to-date") return "check";
  if (state.status === "error" && state.canRetry) {
    if (state.errorContext === "open" && state.availableVersion) return "open";
    if (state.errorContext === "check") return "check";
  }
  return "none";
}

export function shouldShowInstallerUpdateButton(state: InstallerUpdateState | null): boolean {
  if (!state?.enabled) return false;
  return state.status === "opening" || state.status === "error" || state.status === "available";
}

export function isInstallerUpdateButtonDisabled(state: InstallerUpdateState | null): boolean {
  if (!state?.enabled) return true;
  return (
    state.status === "checking" ||
    state.status === "opening" ||
    (state.status === "error" && !state.canRetry)
  );
}

export function getInstallerUpdateButtonTooltip(state: InstallerUpdateState): string {
  const version = state.availableVersion ? ` ${state.availableVersion}` : "";
  if (state.status === "available") {
    const markerContext =
      state.markerStatus === "valid"
        ? ""
        : " The installed version could not be confirmed, so the latest installer is offered.";
    return `Open the full TritonAI Installer${version} download to update Harness, Codex, and managed skills.${markerContext}`;
  }
  if (state.status === "opening") {
    return "Opening the full TritonAI Installer download in your default browser.";
  }
  if (state.status === "checking") {
    return "Checking for a newer full TritonAI Installer.";
  }
  if (state.status === "error") {
    return state.message ?? "Installer update failed. Try again.";
  }
  if (state.status === "disabled") {
    return state.message ?? "TritonAI Installer updates are unavailable in this build.";
  }
  if (state.status === "idle") {
    return "Check for a newer full TritonAI Installer.";
  }
  return "TritonAI Installer is up to date.";
}

export function getInstallerSettingsVersion(state: InstallerUpdateState | null): string {
  return state?.installedVersion ?? "Unknown";
}

export function getInstallerSettingsDescription(
  state: InstallerUpdateState | null,
  harnessVersion: string,
): string {
  if (state?.status === "available" && state.availableVersion) {
    return `Full Installer ${state.availableVersion} is available. Harness component ${harnessVersion}.`;
  }
  if (state?.status === "checking") {
    return `Checking the full Installer version. Harness component ${harnessVersion}.`;
  }
  if (state?.installedVersion) {
    return `Full Installer version. Harness component ${harnessVersion}.`;
  }
  return `Full Installer version unavailable. Harness component ${harnessVersion}.`;
}

export function getInstallerSettingsButtonLabel(state: InstallerUpdateState | null): string {
  if (!state?.enabled) return "Updates Unavailable";
  if (state.status === "checking") return "Checking…";
  if (state.status === "opening") return "Opening…";
  if (state.status === "available") {
    return state.availableVersion ? `Get Update ${state.availableVersion}` : "Get Update";
  }
  if (state.status === "error") {
    if (!state.canRetry) return "Updates Unavailable";
    return state.errorContext === "open" ? "Retry Update" : "Retry";
  }
  return "Check for Updates";
}

export function getInstallerUpdateActionError(result: InstallerUpdateActionResult): string | null {
  if (!result.accepted || result.completed || result.state.errorContext !== "open") return null;
  const message = result.state.message?.trim();
  return message ? message : null;
}
