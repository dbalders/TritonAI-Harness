// @effect-diagnostics nodeBuiltinImport:off
import type * as ServerSecretStore from "../auth/ServerSecretStore.ts";

import type { IntegrationPackage } from "./IntegrationRegistry.ts";
import { loadProductionIntegrations } from "./productionBuiltins.ts";

declare const __TRITONAI_BUILD_SUPPORTS_INTEGRATION_FIXTURES__: boolean | undefined;

const fixtureSupportAvailable =
  typeof __TRITONAI_BUILD_SUPPORTS_INTEGRATION_FIXTURES__ === "undefined" ||
  __TRITONAI_BUILD_SUPPORTS_INTEGRATION_FIXTURES__;

type IntegrationPackageLoader = () => Promise<ReadonlyArray<IntegrationPackage>>;

async function loadBuiltinIntegrationPackages(
  loadFixtures: IntegrationPackageLoader | null,
  loadProduction: IntegrationPackageLoader,
): Promise<ReadonlyArray<IntegrationPackage>> {
  const fixtures = loadFixtures ? await loadFixtures() : [];
  try {
    const production = await loadProduction();
    return [...production, ...fixtures];
  } catch (error) {
    for (const { provider } of fixtures.toReversed()) {
      try {
        await provider?.close?.();
      } catch {
        // Production startup owns the failure. Fixture cleanup must not mask it or prevent the
        // remaining fixture providers from closing.
      }
    }
    throw error;
  }
}

export function loadBuiltinIntegrationPackagesForTest(
  loadFixtures: IntegrationPackageLoader | null,
  loadProduction: IntegrationPackageLoader,
): Promise<ReadonlyArray<IntegrationPackage>> {
  return loadBuiltinIntegrationPackages(loadFixtures, loadProduction);
}

export async function loadBuiltinIntegrations(
  secrets: ServerSecretStore.ServerSecretStore["Service"],
  options: { readonly includeFixtures?: boolean } = {},
): Promise<ReadonlyArray<IntegrationPackage>> {
  const loadFixtures = options.includeFixtures
    ? async () => {
        if (!fixtureSupportAvailable) {
          throw new Error("Integration fixtures are not included in production Harness artifacts.");
        }
        const { makeFixtureIntegrations } = await import("./fixtureBuiltins.ts");
        return makeFixtureIntegrations(secrets);
      }
    : null;
  return loadBuiltinIntegrationPackages(loadFixtures, () => loadProductionIntegrations(secrets));
}
