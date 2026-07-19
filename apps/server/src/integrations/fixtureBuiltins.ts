// @effect-diagnostics nodeBuiltinImport:off
import type * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as NodePath from "node:path";

import type { IntegrationPackage, IntegrationProviderTool } from "./IntegrationRegistry.ts";
import { API_KEY_FIXTURE_TOOLS, ApiKeyMcpFixtureProvider } from "./FixtureProviders.ts";
import { scopeIntegrationSecretStore } from "./IntegrationSecretStore.ts";
import apiKeyManifest from "./packages/authenticated-mcp-fixture/.tritonai-plugin/plugin.json" with { type: "json" };
import skillOnlyManifest from "./packages/skill-only-fixture/.tritonai-plugin/plugin.json" with { type: "json" };
import { validateIntegrationManifest } from "./manifest.ts";

function packageRoot(id: string): string {
  return NodePath.join(import.meta.dirname, "packages", id);
}

type FixtureDescriptor = {
  readonly manifest: ReturnType<typeof validateIntegrationManifest>;
  readonly sourceRoot: string;
  readonly provider: {
    readonly tools: ReadonlyArray<IntegrationProviderTool>;
    readonly legacySecretNames?: Readonly<Record<string, string>>;
    readonly create: (
      scopedSecrets: ServerSecretStore.ServerSecretStore["Service"],
    ) => NonNullable<IntegrationPackage["provider"]>;
  } | null;
};

const FIXTURE_DESCRIPTORS: ReadonlyArray<FixtureDescriptor> = [
  {
    manifest: validateIntegrationManifest(skillOnlyManifest),
    sourceRoot: packageRoot("skill-only-fixture"),
    provider: null,
  },
  {
    manifest: validateIntegrationManifest(apiKeyManifest),
    sourceRoot: packageRoot("authenticated-mcp-fixture"),
    provider: {
      tools: API_KEY_FIXTURE_TOOLS,
      create: (scopedSecrets) => new ApiKeyMcpFixtureProvider(scopedSecrets),
    },
  },
];

export function makeFixtureIntegrations(
  secrets: ServerSecretStore.ServerSecretStore["Service"],
): ReadonlyArray<IntegrationPackage> {
  return FIXTURE_DESCRIPTORS.map(({ manifest, sourceRoot, provider }) => ({
    manifest,
    sourceRoot,
    ...(provider
      ? {
          provider: provider.create(
            scopeIntegrationSecretStore(
              secrets,
              manifest.id,
              provider.legacySecretNames ? { legacyNames: provider.legacySecretNames } : undefined,
            ),
          ),
        }
      : {}),
  }));
}
