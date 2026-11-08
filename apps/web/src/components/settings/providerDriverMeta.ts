import { CodexSettings, ProviderDriverKind } from "@t3tools/contracts";
import { makeProviderClientRegistry } from "@t3tools/provider-core/client";

export const providerClients = makeProviderClientRegistry([
  {
    driverKind: ProviderDriverKind.make("codex"),
    label: "TritonAI",
    settingsSchema: CodexSettings,
  },
]);

const DRIVER_OPTIONS = providerClients.definitions.map((definition) => ({
  ...definition,
  value: definition.driverKind,
}));
export type DriverOption = (typeof DRIVER_OPTIONS)[number];
export type ProviderClientDefinition = DriverOption;
export const DRIVER_OPTION_BY_VALUE: Partial<Record<ProviderDriverKind, DriverOption>> =
  Object.fromEntries(DRIVER_OPTIONS.map((definition) => [definition.value, definition]));
export function getDriverOption(driver: ProviderDriverKind | undefined) {
  return driver === undefined ? undefined : DRIVER_OPTION_BY_VALUE[driver];
}
