import { ClaudeSettings, CodexSettings, ProviderDriverKind } from "@t3tools/contracts";
import { makeProviderClientRegistry } from "@t3tools/provider-core/client";
import { acpRegistryClient } from "@t3tools/provider-acp-registry/client";
import { grokClient } from "@t3tools/provider-grok/client";

// Fixtures for the retained extension architecture; the managed registry stays Codex only.
export const providerClients = makeProviderClientRegistry([
  {
    driverKind: ProviderDriverKind.make("codex"),
    label: "TritonAI",
    settingsSchema: CodexSettings,
  },
  {
    driverKind: ProviderDriverKind.make("claudeAgent"),
    label: "Claude",
    settingsSchema: ClaudeSettings,
  },
  grokClient,
  acpRegistryClient,
]);
export const DRIVER_OPTION_BY_VALUE = Object.fromEntries(
  providerClients.definitions.map((definition) => [
    definition.driverKind,
    { ...definition, value: definition.driverKind },
  ]),
);
export const getDriverOption = (driver: string | undefined) =>
  driver === undefined ? undefined : DRIVER_OPTION_BY_VALUE[driver];
