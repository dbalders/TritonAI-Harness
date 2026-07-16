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

type BuiltinDescriptor = {
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

const skillOnlyIntegration = validateIntegrationManifest(skillOnlyManifest);
const apiKeyIntegration = validateIntegrationManifest(apiKeyManifest);

const SKILL_ONLY_DESCRIPTOR: BuiltinDescriptor = {
  manifest: skillOnlyIntegration,
  sourceRoot: packageRoot("skill-only-fixture"),
  provider: null,
};

const API_KEY_DESCRIPTOR: BuiltinDescriptor = {
  manifest: apiKeyIntegration,
  sourceRoot: packageRoot("authenticated-mcp-fixture"),
  provider: {
    tools: API_KEY_FIXTURE_TOOLS,
    create: (scopedSecrets) => new ApiKeyMcpFixtureProvider(scopedSecrets),
  },
};

function builtinDescriptors(includeFixtures: boolean): ReadonlyArray<BuiltinDescriptor> {
  return includeFixtures ? [SKILL_ONLY_DESCRIPTOR, API_KEY_DESCRIPTOR] : [];
}

export function makeBuiltinIntegrations(
  secrets: ServerSecretStore.ServerSecretStore["Service"],
  options: { readonly includeFixtures?: boolean } = {},
): ReadonlyArray<IntegrationPackage> {
  const descriptors = builtinDescriptors(options.includeFixtures === true);
  const legacySecretOwners = new Map<string, string>();
  for (const { manifest, provider } of descriptors) {
    for (const [suffix, legacyName] of Object.entries(provider?.legacySecretNames ?? {})) {
      const owner = `${manifest.id}:${suffix}`;
      const previousOwner = legacySecretOwners.get(legacyName);
      if (previousOwner) {
        throw new Error(
          `Built-in integration legacy secret ${legacyName} is claimed by ${previousOwner} and ${owner}.`,
        );
      }
      legacySecretOwners.set(legacyName, owner);
    }
  }

  return descriptors.map(({ manifest, sourceRoot, provider }) => ({
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
