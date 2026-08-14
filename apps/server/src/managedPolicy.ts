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
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import developmentManagedConfig from "../../../config/tritonai-managed-config.json" with { type: "json" };
import packageJson from "../package.json" with { type: "json" };

declare const __TRITONAI_BUILD_MANAGED_CONFIG__: unknown;
declare const __TRITONAI_BUILD_MANAGED_CONFIG_DIGEST__: string | undefined;

const MANAGED_POLICY_MIGRATION_VERSION = 2;
const MANAGED_POLICY_MARKER_KEY = "tritonAiManagedPolicy";
const FRONTIER_PROVIDER_COLLISION_RENAME_BASE = "codex_frontier_personal";
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
let managedProviderInstanceRenames: Readonly<Record<string, string>> = {};
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
const diagnosticsListeners = new Set<(diagnostics: TritonAiManagedPolicyDiagnostics) => void>();

export function getManagedPolicyDiagnostics(): TritonAiManagedPolicyDiagnostics {
  return {
    applicationVersion: packageJson.version,
    schemaVersion: managedConfig.schemaVersion,
    policyVersion: managedConfig.policyVersion,
    configDigest: managedConfigDigest,
    loaded: true,
    managedProviderInstanceId: managedConfig.provider.routes.onPrem.instanceId,
    managedProviderInstanceIds: managedRoutes(managedConfig).map((route) => route.instanceId),
    migrationStatus,
    managedCategories: [...managedCategories],
    ...secureSkillsDiagnostics,
  };
}

export function updateSecureSkillsDiagnostics(
  update: Partial<typeof secureSkillsDiagnostics>,
): void {
  secureSkillsDiagnostics = { ...secureSkillsDiagnostics, ...update };
  const diagnostics = getManagedPolicyDiagnostics();
  for (const listener of diagnosticsListeners) listener(diagnostics);
}

export const managedPolicyDiagnosticsChanges = Stream.callback<TritonAiManagedPolicyDiagnostics>(
  (queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const listener = (diagnostics: TritonAiManagedPolicyDiagnostics) => {
          Queue.offerUnsafe(queue, diagnostics);
        };
        diagnosticsListeners.add(listener);
        return listener;
      }),
      (listener) => Effect.sync(() => diagnosticsListeners.delete(listener)),
    ).pipe(Effect.asVoid),
  { bufferSize: 8, strategy: "sliding" },
);

type ManagedRoute =
  | ManagedConfig["provider"]["routes"]["onPrem"]
  | ManagedConfig["provider"]["routes"]["frontier"];

function managedRoutes(config: ManagedConfig): readonly [ManagedRoute, ManagedRoute] {
  return [config.provider.routes.onPrem, config.provider.routes.frontier];
}

function isManagedProviderEnvironmentName(name: string, config: ManagedConfig): boolean {
  const normalized = name.toUpperCase();
  return [
    UCSD_AI_BASE_URL_ENV,
    config.provider.sharedApiKeyEnvironmentVariable,
    config.provider.apiKeySourceEnvironmentVariable,
    ...managedRoutes(config).map((route) => route.apiKeyEnvironmentVariable),
  ].some((managedName) => managedName.toUpperCase() === normalized);
}

function nextPersonalFrontierInstanceId(root: JsonRecord): string {
  const instances = record(root.providerInstances);
  let candidate = `${FRONTIER_PROVIDER_COLLISION_RENAME_BASE}_${NodeCrypto.randomUUID()}`;
  if (!instances) return candidate;
  while (Object.hasOwn(instances, candidate)) {
    candidate = `${FRONTIER_PROVIDER_COLLISION_RENAME_BASE}_${NodeCrypto.randomUUID()}`;
  }
  return candidate;
}

function preserveFrontierProviderCollision(
  root: JsonRecord,
  candidate: string,
): Record<string, string> | undefined {
  const instances = record(root.providerInstances);
  const frontierInstanceId = managedConfig.provider.routes.frontier.instanceId;
  if (!instances || !Object.hasOwn(instances, frontierInstanceId)) return undefined;

  instances[candidate] = instances[frontierInstanceId];
  delete instances[frontierInstanceId];
  for (const selectionKey of [
    "textGenerationModelSelection",
    "sourceControlWriterModelSelection",
  ]) {
    const selection = record(root[selectionKey]);
    if (selection?.instanceId === frontierInstanceId) selection.instanceId = candidate;
  }
  return { [frontierInstanceId]: candidate };
}

function providerInstanceReferenceRenamesFromMarker(
  marker: JsonRecord | null,
): Record<string, string> {
  // This field was introduced with the durable-reference migration. Older
  // collision markers intentionally do not qualify: they may already have
  // produced managed frontier references that cannot be distinguished safely.
  const renames = record(marker?.providerInstanceReferenceRenames);
  const frontierInstanceId = managedConfig.provider.routes.frontier.instanceId;
  const replacement = renames?.[frontierInstanceId];
  if (
    typeof replacement !== "string" ||
    !/^codex_frontier_personal(?:_(?:(?:[2-9]|[1-9][0-9]+)|[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}))?$/.test(
      replacement,
    )
  ) {
    return {};
  }
  return { [frontierInstanceId]: replacement };
}

/** Return the collision renames that must also be applied to durable routing references. */
export function getManagedProviderInstanceRenames(): Readonly<Record<string, string>> {
  return { ...managedProviderInstanceRenames };
}

function modelMetadata(
  models: ManagedConfig["models"]["catalog"],
): ServerSettings["providers"]["codex"]["customModelMetadata"] {
  return Object.fromEntries(
    models.map((model) => [
      model.id,
      {
        name: model.name,
        ...(model.shortName ? { shortName: model.shortName } : {}),
        ...(model.capabilities ? { capabilities: model.capabilities } : {}),
      },
    ]),
  );
}

function availableManagedRouteIds(
  config: ManagedConfig,
  environment: NodeJS.ProcessEnv,
): ReadonlySet<string> {
  const shared = environment[config.provider.sharedApiKeyEnvironmentVariable]?.trim();
  if (shared) return new Set(managedRoutes(config).map((route) => route.id));

  const available = new Set(
    managedRoutes(config)
      .filter((route) => Boolean(environment[route.apiKeyEnvironmentVariable]?.trim()))
      .map((route) => route.id),
  );
  return available;
}

function resolveManagedSelection(
  selection: ServerSettings["textGenerationModelSelection"],
  config: ManagedConfig,
  selectionWasPersisted: boolean,
  availableModels: ManagedConfig["models"]["catalog"],
): ServerSettings["textGenerationModelSelection"] {
  const catalog = new Set(availableModels.map((model) => model.id));
  const selectedModel = selectionWasPersisted ? selection.model : config.models.default;
  const configuredReplacement = Object.hasOwn(config.models.replacements, selectedModel)
    ? config.models.replacements[selectedModel]
    : undefined;
  const replacement =
    configuredReplacement && catalog.has(configuredReplacement) ? configuredReplacement : undefined;
  const fallback = catalog.has(config.models.restrictedFallback)
    ? config.models.restrictedFallback
    : (availableModels[0]?.id ?? config.models.default);
  const model = replacement ?? (catalog.has(selectedModel) ? selectedModel : fallback);
  const managedModel = config.models.catalog.find((candidate) => candidate.id === model);
  const route =
    managedModel?.route === "frontier"
      ? config.provider.routes.frontier
      : config.provider.routes.onPrem;
  return {
    ...selection,
    instanceId: ProviderInstanceId.make(route.instanceId),
    model,
  };
}

export function applyManagedHarnessPolicy(
  persisted: ServerSettings,
  config: ManagedConfig = managedConfig,
  options: {
    readonly textGenerationSelectionWasPersisted?: boolean;
    readonly credentialEnvironment?: NodeJS.ProcessEnv;
  } = {},
): ServerSettings {
  const availableRouteIds = options.credentialEnvironment
    ? availableManagedRouteIds(config, options.credentialEnvironment)
    : new Set(managedRoutes(config).map((route) => route.id));
  const availableModels = config.models.catalog.filter((model) =>
    availableRouteIds.has(model.route),
  );
  const legacyDefaultRouteModels = availableModels.filter(
    (model) => model.route === config.provider.routes.onPrem.id,
  );
  const customModels = legacyDefaultRouteModels.map((model) => model.id);
  const customModelMetadata = modelMetadata(legacyDefaultRouteModels);
  const managedProviderInstances = Object.fromEntries(
    managedRoutes(config).map((route) => {
      const managedInstanceId = ProviderInstanceId.make(route.instanceId);
      const existingInstance = persisted.providerInstances[managedInstanceId];
      const existingConfig = record(existingInstance?.config) ?? {};
      const routeModels = availableModels.filter((model) => model.route === route.id);
      const enabled = availableRouteIds.has(route.id);
      const routeEnvironment = [
        ...(existingInstance?.environment ?? []).filter(
          (variable) => !isManagedProviderEnvironmentName(variable.name, config),
        ),
        { name: UCSD_AI_BASE_URL_ENV, value: config.provider.baseUrl, sensitive: false },
        {
          name: config.provider.apiKeySourceEnvironmentVariable,
          value: route.apiKeyEnvironmentVariable,
          sensitive: false,
        },
      ];
      return [
        managedInstanceId,
        {
          ...existingInstance,
          driver: ProviderDriverKind.make(config.provider.driver),
          displayName: existingInstance?.displayName ?? route.displayName,
          enabled,
          config: {
            ...existingConfig,
            enabled,
            binaryPath: managedRuntimeAnchor.binaryPath,
            homePath: managedRuntimeAnchor.homePath,
            customModels: routeModels.map((model) => model.id),
            customModelMetadata: modelMetadata(routeModels),
          },
          environment: routeEnvironment,
        },
      ];
    }),
  );

  const sourceControlWriterModelSelection = persisted.sourceControlWriterModelSelection
    ? resolveManagedSelection(
        persisted.sourceControlWriterModelSelection,
        config,
        true,
        availableModels,
      )
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
      ...managedProviderInstances,
    },
    textGenerationModelSelection: resolveManagedSelection(
      persisted.textGenerationModelSelection,
      config,
      options.textGenerationSelectionWasPersisted ?? true,
      availableModels,
    ),
    sourceControlWriterModelSelection,
  };
}

/** Remove only fields owned by the Harness overlay before settings are persisted. */
export function stripManagedFieldsForPersistence(settings: ServerSettings): ServerSettings {
  const providerInstances = { ...settings.providerInstances };
  for (const route of managedRoutes(managedConfig)) {
    const managedInstanceId = ProviderInstanceId.make(route.instanceId);
    const managedInstance = settings.providerInstances[managedInstanceId];
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
      (variable) => !isManagedProviderEnvironmentName(variable.name, managedConfig),
    );
    const hasUserInstanceState =
      Object.keys(userInstanceConfig).length > 0 ||
      userEnvironment.length > 0 ||
      (managedInstance?.displayName !== undefined &&
        managedInstance.displayName !== route.displayName) ||
      managedInstance?.accentColor !== undefined;
    if (hasUserInstanceState && managedInstance) {
      const {
        enabled: _instanceEnabled,
        displayName: _instanceDisplayName,
        config: _instanceConfig,
        environment: _instanceEnvironment,
        ...userInstanceEnvelope
      } = managedInstance;
      providerInstances[managedInstanceId] = {
        ...userInstanceEnvelope,
        driver: ProviderDriverKind.make("codex"),
        ...(managedInstance.displayName !== route.displayName
          ? { displayName: managedInstance.displayName }
          : {}),
        ...(Object.keys(userInstanceConfig).length > 0 ? { config: userInstanceConfig } : {}),
        ...(userEnvironment.length > 0 ? { environment: userEnvironment } : {}),
      };
    } else {
      delete providerInstances[managedInstanceId];
    }
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
  if (!root) {
    managedProviderInstanceRenames = {};
    return { document: input, migrated: false };
  }
  const marker = record(root[MANAGED_POLICY_MARKER_KEY]);
  if (marker?.migrationVersion === MANAGED_POLICY_MIGRATION_VERSION) {
    managedProviderInstanceRenames = providerInstanceReferenceRenamesFromMarker(marker);
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
    migrationStatus = "completed";
    return { document: input, migrated: false };
  }

  const next = structuredClone(root);
  const frontierInstanceId = managedConfig.provider.routes.frontier.instanceId;
  const personalFrontierInstanceId = nextPersonalFrontierInstanceId(next);
  const providerInstanceRenames = preserveFrontierProviderCollision(
    next,
    personalFrontierInstanceId,
  );
  // Version 1 could leave durable references behind even after a personal
  // provider was removed from settings. Move every pre-v2 reference away from
  // the newly claimed managed ID. When the provider still exists, this target
  // is also the ID assigned to it; otherwise it remains an intentionally
  // unbound tombstone instead of silently binding to managed credentials.
  const providerInstanceReferenceRenames = {
    [frontierInstanceId]: personalFrontierInstanceId,
  };
  managedProviderInstanceRenames = providerInstanceReferenceRenames;
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
          return typeof name !== "string" || !isManagedProviderEnvironmentName(name, managedConfig);
        })
      : undefined;
    if (environment && environment.length > 0) codexInstance.environment = environment;
    else delete codexInstance.environment;
  }

  next[MANAGED_POLICY_MARKER_KEY] = {
    migrationVersion: MANAGED_POLICY_MIGRATION_VERSION,
    codexBinaryPath: managedRuntimeAnchor.binaryPath,
    codexHomePath: managedRuntimeAnchor.homePath,
    ...(providerInstanceRenames ? { providerInstanceRenames } : {}),
    // This field is written for every v1-to-v2 migration, not just a live
    // settings collision, because provider references outlive provider rows.
    providerInstanceReferenceRenames,
  };
  migrationStatus = "completed";
  return { document: next, migrated: true };
}
