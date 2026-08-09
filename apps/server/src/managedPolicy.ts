// @effect-diagnostics nodeBuiltinImport:off - the signed config identity is computed once at startup.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  DEFAULT_SERVER_SETTINGS,
  DEFAULT_TRITONAI_CODEX_HOME_PATH,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerSettings,
  TritonAiManagedConfig,
  type TritonAiManagedConfig as ManagedConfig,
  type TritonAiManagedPolicyDiagnostics,
  UCSD_AI_BASE_URL_ENV,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import developmentManagedConfig from "../../../config/tritonai-managed-config.json" with { type: "json" };
import packageJson from "../package.json" with { type: "json" };

declare const __TRITONAI_BUILD_MANAGED_CONFIG__: unknown;
declare const __TRITONAI_BUILD_MANAGED_CONFIG_DIGEST__: string | undefined;

const MANAGED_POLICY_MIGRATION_VERSION = 1;
const MANAGED_POLICY_MARKER_KEY = "tritonAiManagedPolicy";
const MANAGED_PROVIDER_INSTANCE_ID = ProviderInstanceId.make("codex");
const managedCategories = [
  "provider identity and routing",
  "managed Codex binary and home",
  "managed model catalog and fallbacks",
  "optional authenticated secure skills",
] as const;

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

const decodeManagedConfig = Schema.decodeUnknownSync(TritonAiManagedConfig);
const decodeUnknownJson = Schema.decodeUnknownSync(Schema.UnknownFromJsonString);

export function validateBundledManagedConfig(
  source: string,
  embeddedConfig: unknown,
  expectedDigest: string | undefined,
  resourcePath = "<managed-config>",
): { readonly config: ManagedConfig; readonly digest: string } {
  const config = decodeManagedConfig(decodeUnknownJson(source), { onExcessProperty: "error" });
  const decodedEmbeddedConfig = decodeManagedConfig(embeddedConfig, {
    onExcessProperty: "error",
  });
  const digest = NodeCrypto.createHash("sha256").update(source).digest("hex");
  if (
    digest !== expectedDigest ||
    JSON.stringify(config) !== JSON.stringify(decodedEmbeddedConfig)
  ) {
    throw new Error(
      `Bundled TritonAI managed config identity mismatch at ${resourcePath}. Reinstall the signed Harness application.`,
    );
  }
  return { config, digest };
}

function loadManagedConfig(): { readonly config: ManagedConfig; readonly digest: string } {
  if (typeof __TRITONAI_BUILD_MANAGED_CONFIG__ === "undefined") {
    const config = decodeManagedConfig(developmentManagedConfig, { onExcessProperty: "error" });
    return {
      config,
      digest: NodeCrypto.createHash("sha256").update(JSON.stringify(config)).digest("hex"),
    };
  }

  const resourcePath = NodePath.join(import.meta.dirname, "tritonai-managed-config.json");
  const source = NodeFS.readFileSync(resourcePath, "utf8");
  return validateBundledManagedConfig(
    source,
    __TRITONAI_BUILD_MANAGED_CONFIG__,
    __TRITONAI_BUILD_MANAGED_CONFIG_DIGEST__,
    resourcePath,
  );
}

const loadedManagedConfig = loadManagedConfig();
export const managedConfig = loadedManagedConfig.config;
export const managedConfigDigest = loadedManagedConfig.digest;

let migrationStatus: TritonAiManagedPolicyDiagnostics["migrationStatus"] = "not-needed";
let managedRuntimeAnchor = {
  binaryPath: DEFAULT_SERVER_SETTINGS.providers.codex.binaryPath,
  homePath: DEFAULT_TRITONAI_CODEX_HOME_PATH,
};
let secureSkillsDiagnostics: Pick<
  TritonAiManagedPolicyDiagnostics,
  | "secureSkillsStatus"
  | "secureSkillsRevision"
  | "secureSkillsLastCheckedAt"
  | "secureSkillsMessage"
> = {
  secureSkillsStatus: managedConfig.secureSkills.endpoint ? "idle" : "not-configured",
  secureSkillsRevision: null,
  secureSkillsLastCheckedAt: null,
  secureSkillsMessage: managedConfig.secureSkills.endpoint
    ? "Secure skills have not been checked yet."
    : "No secure-skills endpoint is configured in this Harness release.",
};

export function getManagedPolicyDiagnostics(): TritonAiManagedPolicyDiagnostics {
  return {
    applicationVersion: packageJson.version,
    schemaVersion: managedConfig.schemaVersion,
    policyVersion: managedConfig.policyVersion,
    configDigest: managedConfigDigest,
    loaded: true,
    migrationStatus,
    managedCategories: [...managedCategories],
    ...secureSkillsDiagnostics,
  };
}

export function updateSecureSkillsDiagnostics(
  update: Partial<typeof secureSkillsDiagnostics>,
): void {
  secureSkillsDiagnostics = { ...secureSkillsDiagnostics, ...update };
}

function modelMetadata(
  config: ManagedConfig,
): ServerSettings["providers"]["codex"]["customModelMetadata"] {
  return Object.fromEntries(
    config.models.catalog.map((model) => [
      model.id,
      {
        name: model.name,
        ...(model.shortName ? { shortName: model.shortName } : {}),
        ...(model.capabilities ? { capabilities: model.capabilities } : {}),
      },
    ]),
  );
}

function resolveManagedSelection(
  selection: ServerSettings["textGenerationModelSelection"],
  config: ManagedConfig,
  selectionWasPersisted: boolean,
): ServerSettings["textGenerationModelSelection"] {
  const catalog = new Set(config.models.catalog.map((model) => model.id));
  const selectedModel = selectionWasPersisted ? selection.model : config.models.default;
  const replacement = config.models.replacements[selectedModel];
  const model =
    replacement ?? (catalog.has(selectedModel) ? selectedModel : config.models.restrictedFallback);
  return {
    ...selection,
    instanceId: ProviderInstanceId.make(config.provider.instanceId),
    model,
  };
}

export function applyManagedHarnessPolicy(
  persisted: ServerSettings,
  config: ManagedConfig = managedConfig,
  options: { readonly textGenerationSelectionWasPersisted?: boolean } = {},
): ServerSettings {
  const managedInstanceId = ProviderInstanceId.make(config.provider.instanceId);
  const existingInstance = persisted.providerInstances[managedInstanceId];
  const existingConfig = record(existingInstance?.config) ?? {};
  const existingEnvironment = existingInstance?.environment ?? [];
  const environment = [
    ...existingEnvironment.filter(
      (variable) =>
        variable.name.toUpperCase() !== UCSD_AI_BASE_URL_ENV &&
        variable.name.toUpperCase() !== config.provider.apiKeyEnvironmentVariable,
    ),
    { name: UCSD_AI_BASE_URL_ENV, value: config.provider.baseUrl, sensitive: false },
  ];
  const customModels = config.models.catalog.map((model) => model.id);
  const customModelMetadata = modelMetadata(config);
  const managedCodexConfig = {
    ...existingConfig,
    enabled: true,
    binaryPath: managedRuntimeAnchor.binaryPath,
    homePath: managedRuntimeAnchor.homePath,
    customModels,
    customModelMetadata,
  };

  const sourceControlWriterModelSelection = persisted.sourceControlWriterModelSelection
    ? resolveManagedSelection(persisted.sourceControlWriterModelSelection, config, true)
    : null;

  return {
    ...persisted,
    providers: {
      ...persisted.providers,
      codex: {
        ...persisted.providers.codex,
        enabled: true,
        binaryPath: managedRuntimeAnchor.binaryPath,
        homePath: managedRuntimeAnchor.homePath,
        customModels,
        customModelMetadata,
      },
    },
    providerInstances: {
      ...persisted.providerInstances,
      [managedInstanceId]: {
        ...existingInstance,
        driver: ProviderDriverKind.make(config.provider.driver),
        enabled: true,
        config: managedCodexConfig,
        environment,
      },
    },
    textGenerationModelSelection: resolveManagedSelection(
      persisted.textGenerationModelSelection,
      config,
      options.textGenerationSelectionWasPersisted ?? true,
    ),
    sourceControlWriterModelSelection,
  };
}

/** Remove only fields owned by the Harness overlay before settings are persisted. */
export function stripManagedFieldsForPersistence(settings: ServerSettings): ServerSettings {
  const managedInstance = settings.providerInstances[MANAGED_PROVIDER_INSTANCE_ID];
  const managedInstanceConfig = record(managedInstance?.config) ?? {};
  const {
    enabled: _enabled,
    binaryPath: _binaryPath,
    homePath: _homePath,
    customModels: _customModels,
    customModelMetadata: _customModelMetadata,
    ...userInstanceConfig
  } = managedInstanceConfig;
  const userEnvironment = (managedInstance?.environment ?? []).filter(
    (variable) =>
      variable.name.toUpperCase() !== UCSD_AI_BASE_URL_ENV &&
      variable.name.toUpperCase() !== managedConfig.provider.apiKeyEnvironmentVariable,
  );
  const hasUserInstanceState =
    Object.keys(userInstanceConfig).length > 0 ||
    userEnvironment.length > 0 ||
    managedInstance?.displayName !== undefined ||
    managedInstance?.accentColor !== undefined;
  const providerInstances = { ...settings.providerInstances };
  if (hasUserInstanceState && managedInstance) {
    const {
      enabled: _instanceEnabled,
      config: _instanceConfig,
      environment: _instanceEnvironment,
      ...userInstanceEnvelope
    } = managedInstance;
    providerInstances[MANAGED_PROVIDER_INSTANCE_ID] = {
      ...userInstanceEnvelope,
      driver: ProviderDriverKind.make("codex"),
      ...(Object.keys(userInstanceConfig).length > 0 ? { config: userInstanceConfig } : {}),
      ...(userEnvironment.length > 0 ? { environment: userEnvironment } : {}),
    };
  } else {
    delete providerInstances[MANAGED_PROVIDER_INSTANCE_ID];
  }

  return {
    ...settings,
    providers: {
      ...settings.providers,
      codex: {
        ...settings.providers.codex,
        enabled: DEFAULT_SERVER_SETTINGS.providers.codex.enabled,
        binaryPath: DEFAULT_SERVER_SETTINGS.providers.codex.binaryPath,
        homePath: DEFAULT_SERVER_SETTINGS.providers.codex.homePath,
        customModels: DEFAULT_SERVER_SETTINGS.providers.codex.customModels,
        customModelMetadata: DEFAULT_SERVER_SETTINGS.providers.codex.customModelMetadata,
      },
    },
    providerInstances,
  };
}

export function rawSettingsHasTextGenerationSelection(raw: unknown): boolean {
  return Object.hasOwn(record(raw) ?? {}, "textGenerationModelSelection");
}

export interface LegacyManagedSettingsMigrationResult {
  readonly document: unknown;
  readonly migrated: boolean;
}

/**
 * Remove the exact default `codex` fields written by the legacy Installer.
 * Separate provider instances, plugin state, unknown fields, and user content
 * are intentionally outside this migration boundary.
 */
export function migrateLegacyInstallerManagedSettings(
  input: unknown,
): LegacyManagedSettingsMigrationResult {
  const root = record(input);
  if (!root) return { document: input, migrated: false };
  const marker = record(root[MANAGED_POLICY_MARKER_KEY]);
  if (marker?.migrationVersion === MANAGED_POLICY_MIGRATION_VERSION) {
    managedRuntimeAnchor = {
      binaryPath:
        typeof marker.codexBinaryPath === "string" && marker.codexBinaryPath.trim()
          ? marker.codexBinaryPath
          : DEFAULT_SERVER_SETTINGS.providers.codex.binaryPath,
      homePath:
        typeof marker.codexHomePath === "string" && marker.codexHomePath.trim()
          ? marker.codexHomePath
          : DEFAULT_TRITONAI_CODEX_HOME_PATH,
    };
    return { document: input, migrated: false };
  }

  const next = structuredClone(root);
  const providers = record(next.providers);
  const codexProvider = record(providers?.codex);
  const instancesBeforeMigration = record(next.providerInstances);
  const codexInstanceBeforeMigration = record(instancesBeforeMigration?.codex);
  const codexConfigBeforeMigration = record(codexInstanceBeforeMigration?.config);
  managedRuntimeAnchor = {
    binaryPath:
      typeof codexConfigBeforeMigration?.binaryPath === "string" &&
      codexConfigBeforeMigration.binaryPath.trim()
        ? codexConfigBeforeMigration.binaryPath
        : typeof codexProvider?.binaryPath === "string" && codexProvider.binaryPath.trim()
          ? codexProvider.binaryPath
          : DEFAULT_SERVER_SETTINGS.providers.codex.binaryPath,
    homePath:
      typeof codexConfigBeforeMigration?.homePath === "string" &&
      codexConfigBeforeMigration.homePath.trim()
        ? codexConfigBeforeMigration.homePath
        : typeof codexProvider?.homePath === "string" && codexProvider.homePath.trim()
          ? codexProvider.homePath
          : DEFAULT_TRITONAI_CODEX_HOME_PATH,
  };
  for (const key of ["enabled", "binaryPath", "homePath", "customModels", "customModelMetadata"]) {
    delete codexProvider?.[key];
  }

  const instances = record(next.providerInstances);
  const codexInstance = record(instances?.codex);
  const codexConfig = record(codexInstance?.config);
  for (const key of ["enabled", "binaryPath", "homePath", "customModels", "customModelMetadata"]) {
    delete codexConfig?.[key];
  }
  if (codexInstance) {
    delete codexInstance.enabled;
    const environment = Array.isArray(codexInstance.environment)
      ? codexInstance.environment.filter((entry) => {
          const name = record(entry)?.name;
          return (
            typeof name !== "string" ||
            (name.toUpperCase() !== UCSD_AI_BASE_URL_ENV &&
              name.toUpperCase() !== managedConfig.provider.apiKeyEnvironmentVariable)
          );
        })
      : undefined;
    if (environment && environment.length > 0) codexInstance.environment = environment;
    else delete codexInstance.environment;
  }

  next[MANAGED_POLICY_MARKER_KEY] = {
    migrationVersion: MANAGED_POLICY_MIGRATION_VERSION,
    codexBinaryPath: managedRuntimeAnchor.binaryPath,
    codexHomePath: managedRuntimeAnchor.homePath,
  };
  migrationStatus = "completed";
  return { document: next, migrated: true };
}
