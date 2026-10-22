import type { EnvironmentId } from "@t3tools/contracts";
import type { SettingsScopeSearch } from "./settingsScope";

export function settingsContentScopeKey(
  pathname: string,
  search: SettingsScopeSearch,
  connectedEnvironmentId: EnvironmentId | undefined,
): string | undefined {
  // The provider page resolves a single machine even while it is offline.
  // Keying by the connected representative remounts its credential-update
  // owner during a key change, erasing the expected restart status.
  if (pathname === "/settings/providers") return search.machine ?? connectedEnvironmentId;
  if (pathname === "/settings/diagnostics") return connectedEnvironmentId;
  return JSON.stringify(search);
}
