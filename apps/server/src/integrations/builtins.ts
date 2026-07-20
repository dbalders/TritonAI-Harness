// @effect-diagnostics nodeBuiltinImport:off
import type * as ServerSecretStore from "../auth/ServerSecretStore.ts";

import type { IntegrationPackage } from "./IntegrationRegistry.ts";
import { loadProductionIntegrations } from "./productionBuiltins.ts";

declare const __TRITONAI_BUILD_SUPPORTS_INTEGRATION_FIXTURES__: boolean | undefined;

const fixtureSupportAvailable =
  typeof __TRITONAI_BUILD_SUPPORTS_INTEGRATION_FIXTURES__ === "undefined" ||
  __TRITONAI_BUILD_SUPPORTS_INTEGRATION_FIXTURES__;

export async function loadBuiltinIntegrations(
  secrets: ServerSecretStore.ServerSecretStore["Service"],
  options: { readonly includeFixtures?: boolean } = {},
): Promise<ReadonlyArray<IntegrationPackage>> {
  const production = await loadProductionIntegrations(secrets);
  if (!options.includeFixtures) return production;
  if (!fixtureSupportAvailable) {
    throw new Error("Integration fixtures are not included in production Harness artifacts.");
  }
  const { makeFixtureIntegrations } = await import("./fixtureBuiltins.ts");
  return [...production, ...makeFixtureIntegrations(secrets)];
}
