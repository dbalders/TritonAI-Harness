import type { InstallerUpdateActionResult, InstallerUpdateState } from "@t3tools/contracts";

export type InstallerUpdateButtonAction = "open" | "check" | "none";

export function resolveInstallerUpdateButtonAction(
  state: InstallerUpdateState,
): InstallerUpdateButtonAction {
  if (state.status === "available") return "open";
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
  return (
    state?.status === "checking" ||
    state?.status === "opening" ||
    (state?.status === "error" && !state.canRetry)
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
  if (state.status === "error") {
    return state.message ?? "Installer update failed. Try again.";
  }
  return "TritonAI Installer is up to date.";
}

export function getInstallerUpdateActionError(result: InstallerUpdateActionResult): string | null {
  if (!result.accepted || result.completed || result.state.errorContext !== "open") return null;
  const message = result.state.message?.trim();
  return message ? message : null;
}
