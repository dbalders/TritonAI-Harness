import type { DesktopUpdateChannel } from "@t3tools/contracts";

import { isTritonAiNightlyVersion } from "@t3tools/contracts";

export function isNightlyDesktopVersion(version: string): boolean {
  return isTritonAiNightlyVersion(version) || /^[^-+]+-preview\.\d{8}\.\d+$/.test(version);
}

export function resolveDefaultDesktopUpdateChannel(appVersion: string): DesktopUpdateChannel {
  return isTritonAiNightlyVersion(appVersion) ? "nightly" : "latest";
}
