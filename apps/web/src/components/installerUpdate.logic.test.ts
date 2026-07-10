import type { InstallerUpdateState } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  getInstallerSettingsButtonLabel,
  getInstallerSettingsDescription,
  getInstallerSettingsVersion,
  getInstallerUpdateActionError,
  getInstallerUpdateButtonTooltip,
  isInstallerUpdateButtonDisabled,
  resolveInstallerUpdateButtonAction,
  shouldShowInstallerUpdateButton,
} from "./installerUpdate.logic.ts";

const baseState: InstallerUpdateState = {
  enabled: true,
  status: "idle",
  installedVersion: "1.0.0",
  availableVersion: null,
  markerStatus: "valid",
  checkedAt: null,
  message: null,
  errorContext: null,
  canRetry: false,
};

describe("installer update sidebar behavior", () => {
  it("offers the full installer when an update is available", () => {
    const state = { ...baseState, status: "available", availableVersion: "1.1.0" } as const;
    expect(shouldShowInstallerUpdateButton(state)).toBe(true);
    expect(resolveInstallerUpdateButtonAction(state)).toBe("open");
    expect(getInstallerUpdateButtonTooltip(state)).toContain("Harness, Codex, and managed skills");
  });

  it("keeps manual checks available while the sidebar remains passive", () => {
    const current = { ...baseState, status: "up-to-date" } as const;
    expect(resolveInstallerUpdateButtonAction(current)).toBe("check");
    expect(isInstallerUpdateButtonDisabled(current)).toBe(false);
    expect(shouldShowInstallerUpdateButton(current)).toBe(false);
  });

  it("offers check and open retries for the matching error context", () => {
    const checkError = {
      ...baseState,
      status: "error",
      errorContext: "check",
      canRetry: true,
      message: "Network unavailable",
    } as const;
    expect(resolveInstallerUpdateButtonAction(checkError)).toBe("check");
    expect(getInstallerUpdateButtonTooltip(checkError)).toBe("Network unavailable");

    const openError = {
      ...baseState,
      status: "error",
      availableVersion: "1.1.0",
      errorContext: "open",
      canRetry: true,
    } as const;
    expect(resolveInstallerUpdateButtonAction(openError)).toBe("open");
  });

  it("disables the control during the browser handoff", () => {
    const state = { ...baseState, status: "opening" } as const;
    expect(shouldShowInstallerUpdateButton(state)).toBe(true);
    expect(isInstallerUpdateButtonDisabled(state)).toBe(true);
    expect(resolveInstallerUpdateButtonAction(state)).toBe("none");
  });

  it("hides unsupported packaged targets", () => {
    const state = {
      ...baseState,
      enabled: false,
      status: "disabled",
      errorContext: null,
      canRetry: false,
      message: null,
    } as const;
    expect(shouldShowInstallerUpdateButton(state)).toBe(false);
    expect(resolveInstallerUpdateButtonAction(state)).toBe("none");
    expect(isInstallerUpdateButtonDisabled(state)).toBe(true);
  });

  it("surfaces accepted open failures and ignores non-actions", () => {
    const failedState = {
      ...baseState,
      status: "error",
      availableVersion: "1.1.0",
      message: "Could not open installer.",
      errorContext: "open",
      canRetry: true,
    } as const;
    expect(
      getInstallerUpdateActionError({ accepted: true, completed: false, state: failedState }),
    ).toBe("Could not open installer.");
    expect(
      getInstallerUpdateActionError({ accepted: false, completed: false, state: failedState }),
    ).toBeNull();
  });

  it("explains why a missing marker still gets the latest installer", () => {
    const state = {
      ...baseState,
      status: "available",
      installedVersion: null,
      availableVersion: "1.1.0",
      markerStatus: "missing",
    } as const;
    expect(getInstallerUpdateButtonTooltip(state)).toContain("could not be confirmed");
  });
});

describe("installer update settings behavior", () => {
  it("presents the Installer version as the product version and Harness as a component", () => {
    const state = { ...baseState, status: "up-to-date" } as const;
    expect(getInstallerSettingsVersion(state)).toBe("1.0.0");
    expect(getInstallerSettingsDescription(state, "0.9.5")).toBe(
      "Full Installer version. Harness component 0.9.5.",
    );
    expect(getInstallerSettingsButtonLabel(state)).toBe("Check for Updates");
  });

  it("makes an available full Installer update explicit", () => {
    const state = {
      ...baseState,
      status: "available",
      availableVersion: "1.1.0",
    } as const;
    expect(getInstallerSettingsDescription(state, "0.9.5")).toBe(
      "Full Installer 1.1.0 is available. Harness component 0.9.5.",
    );
    expect(getInstallerSettingsButtonLabel(state)).toBe("Get Update 1.1.0");
  });

  it("does not mislabel the Harness version when the Installer marker is unavailable", () => {
    expect(getInstallerSettingsVersion(null)).toBe("Unknown");
    expect(getInstallerSettingsDescription(null, "0.9.5")).toBe(
      "Full Installer version unavailable. Harness component 0.9.5.",
    );
    expect(getInstallerSettingsButtonLabel(null)).toBe("Updates Unavailable");
    expect(isInstallerUpdateButtonDisabled(null)).toBe(true);
  });
});
