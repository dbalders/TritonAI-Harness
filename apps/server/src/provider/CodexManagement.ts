import {
  CodexSettings,
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerInstallProviderSkillInput,
  ServerMarketplaceAddInput,
  ServerMarketplaceRemoveInput,
  ServerMarketplaceUpgradeInput,
  ServerPluginInstallInput,
  ServerPluginOperationError,
  type ServerPluginsListResult,
  ServerPluginUninstallInput,
  type ServerProvider,
  ServerProviderSkillConfigError,
  ServerProviderSkillInstallError,
  type ServerProviderUpdatedPayload,
  ServerRemoveProviderSkillInput,
  ServerSetProviderSkillEnabledInput,
} from "@t3tools/contracts";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";
import * as Scope from "effect/Scope";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as CodexClient from "effect-codex-app-server/client";
import * as CodexErrors from "effect-codex-app-server/errors";
import type * as CodexSchema from "effect-codex-app-server/schema";

import * as ServerConfig from "../config.ts";
import { buildCodexInitializeParams } from "./Layers/CodexProvider.ts";
import { expandHomePath } from "../pathExpansion.ts";
import {
  materializeCodexShadowHome,
  resolveCodexHomeLayout,
} from "./Drivers/CodexHomeLayout.ts";
import { makeTritonAiCodexConfigArgs } from "./Drivers/TritonAiCodexConfig.ts";
import { mergeProviderInstanceEnvironment } from "./ProviderInstanceEnvironment.ts";
import {
  discardProviderSkillInstallRollback,
  installProviderSkill,
  listProviderSkillCatalog,
  rollbackProviderSkillInstall,
} from "./installProviderSkill.ts";
import { removeProviderSkillFolder, resolveProviderSkillRemovalTarget } from "./removeProviderSkill.ts";
import * as ProviderRegistry from "./Services/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";

const CODEX_DRIVER = ProviderDriverKind.make("codex");
const CODEX_APP_SERVER_MANAGEMENT_FORCE_KILL_AFTER = "2 seconds" as const;

const decodeCodexSettings = Schema.decodeUnknownEffect(CodexSettings);
const decodeInstallSkillInput = Schema.decodeUnknownEffect(ServerInstallProviderSkillInput);
const decodeRemoveSkillInput = Schema.decodeUnknownEffect(ServerRemoveProviderSkillInput);
const decodeSetSkillEnabledInput = Schema.decodeUnknownEffect(ServerSetProviderSkillEnabledInput);
const decodePluginInstallInput = Schema.decodeUnknownEffect(ServerPluginInstallInput);
const decodePluginUninstallInput = Schema.decodeUnknownEffect(ServerPluginUninstallInput);
const decodeMarketplaceAddInput = Schema.decodeUnknownEffect(ServerMarketplaceAddInput);
const decodeMarketplaceRemoveInput = Schema.decodeUnknownEffect(ServerMarketplaceRemoveInput);
const decodeMarketplaceUpgradeInput = Schema.decodeUnknownEffect(ServerMarketplaceUpgradeInput);

function schemaIssue(error: Schema.SchemaError): string {
  return SchemaIssue.makeFormatterDefault()(error.issue);
}

function pluginError(message: string, cause?: unknown) {
  return new ServerPluginOperationError({
    message,
    ...(cause !== undefined ? { cause } : {}),
  });
}

function skillConfigError(message: string, cause?: unknown) {
  return new ServerProviderSkillConfigError({
    message,
    ...(cause !== undefined ? { cause } : {}),
  });
}

function skillInstallError(message: string, cause?: unknown) {
  return new ServerProviderSkillInstallError({
    message,
    ...(cause !== undefined ? { cause } : {}),
  });
}

function nonEmpty(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function nullableNonEmpty(value: string | null | undefined): string | null | undefined {
  return value === null ? null : nonEmpty(value);
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function mapPluginSource(source: CodexSchema.V2PluginListResponse__PluginSource) {
  switch (source.type) {
    case "local": {
      return { type: "local" as const, path: source.path };
    }
    case "git": {
      const path = nonEmpty(source.path);
      const refName = nonEmpty(source.refName);
      const sha = nonEmpty(source.sha);
      return {
        type: "git" as const,
        url: source.url,
        ...(path !== undefined ? { path } : {}),
        ...(refName !== undefined ? { refName } : {}),
        ...(sha !== undefined ? { sha } : {}),
      };
    }
    case "remote": {
      return { type: "remote" as const };
    }
    default:
      source satisfies never;
      return { type: "remote" as const };
  }
}

function mapPluginListResponse(
  response: CodexSchema.V2PluginListResponse,
): ServerPluginsListResult {
  return {
    featuredPluginIds: [...(response.featuredPluginIds ?? [])],
    marketplaceLoadErrors: (response.marketplaceLoadErrors ?? []).map((error) => ({
      marketplacePath: error.marketplacePath,
      message: error.message,
    })),
    marketplaces: response.marketplaces.map((marketplace) => {
      const displayName = nonEmpty(marketplace.interface?.displayName);
      const marketplacePath = nullableNonEmpty(marketplace.path);

      return {
        name: marketplace.name,
        ...(displayName !== undefined ? { displayName } : {}),
        ...(marketplacePath !== undefined ? { path: marketplacePath } : {}),
        plugins: marketplace.plugins.map((plugin) => {
          const pluginDisplayName = nonEmpty(plugin.interface?.displayName);
          const description = nonEmpty(
            plugin.interface?.shortDescription ?? plugin.interface?.longDescription,
          );
          const category = nonEmpty(plugin.interface?.category);
          const developerName = nonEmpty(plugin.interface?.developerName);
          const localVersion = nullableNonEmpty(plugin.localVersion);
          const remotePluginId = nullableNonEmpty(plugin.remotePluginId);

          return {
            id: plugin.id,
            name: plugin.name,
            ...(pluginDisplayName !== undefined ? { displayName: pluginDisplayName } : {}),
            ...(description !== undefined ? { description } : {}),
            ...(category !== undefined ? { category } : {}),
            ...(developerName !== undefined ? { developerName } : {}),
            enabled: plugin.enabled,
            installed: plugin.installed,
            ...(plugin.availability !== undefined ? { availability: plugin.availability } : {}),
            ...(localVersion !== undefined ? { localVersion } : {}),
            ...(remotePluginId !== undefined ? { remotePluginId } : {}),
            marketplaceName: marketplace.name,
            ...(marketplacePath !== undefined ? { marketplacePath } : {}),
            source: mapPluginSource(plugin.source),
            keywords: [...(plugin.keywords ?? [])],
          };
        }),
      };
    }),
  };
}

interface CodexManagementTarget {
  readonly instanceId: ProviderInstanceId;
  readonly cwd: string;
  readonly binaryPath: string;
  readonly effectiveHomePath: string;
  readonly sharedHomePath: string;
  readonly environment: NodeJS.ProcessEnv;
}

const resolveCodexManagementTarget = Effect.fn("resolveCodexManagementTarget")(function* (
  requestedInstanceId?: ProviderInstanceId,
) {
  const config = yield* ServerConfig.ServerConfig;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const path = yield* Path.Path;
  const settings = yield* settingsService.getSettings.pipe(
    Effect.mapError((cause) =>
      pluginError(`Failed to read Codex settings: ${errorMessage(cause)}`, cause),
    ),
  );
  const defaultInstanceId = defaultInstanceIdForDriver(CODEX_DRIVER);
  const instanceId = requestedInstanceId ?? defaultInstanceId;
  const instanceConfig = settings.providerInstances[instanceId];

  if (instanceConfig !== undefined && instanceConfig.driver !== CODEX_DRIVER) {
    return yield* pluginError(
      `Provider instance '${instanceId}' is backed by '${instanceConfig.driver}', not Codex.`,
    );
  }
  if (instanceConfig === undefined && instanceId !== defaultInstanceId) {
    return yield* pluginError(`Codex provider instance '${instanceId}' was not found.`);
  }

  const rawConfig = instanceConfig?.config ?? settings.providers.codex;
  const codexSettings = yield* decodeCodexSettings(rawConfig).pipe(
    Effect.mapError((cause) => pluginError(`Codex settings were invalid: ${schemaIssue(cause)}`, cause)),
  );
  const environment = mergeProviderInstanceEnvironment(instanceConfig?.environment);
  const configuredHomePath = codexSettings.homePath.trim();
  const managedConfig = {
    ...codexSettings,
    homePath:
      configuredHomePath.length > 0 ? codexSettings.homePath : path.join(config.baseDir, "codex"),
  } satisfies CodexSettings;
  const layout = yield* resolveCodexHomeLayout(managedConfig);
  yield* materializeCodexShadowHome(layout).pipe(
    Effect.mapError((cause) => pluginError(cause.message, cause)),
  );
  const effectiveHomePath = layout.effectiveHomePath ?? layout.sharedHomePath;

  return {
    instanceId,
    cwd: config.cwd,
    binaryPath: managedConfig.binaryPath,
    effectiveHomePath,
    sharedHomePath: layout.sharedHomePath,
    environment,
  } satisfies CodexManagementTarget;
});

function codexOperationError(operation: string, cause: unknown) {
  return pluginError(`Codex app-server ${operation} failed: ${errorMessage(cause)}`, cause);
}

function isRemotePluginCatalogAuthError(cause: unknown): boolean {
  const message = errorMessage(cause).toLowerCase();
  if (
    message.includes("remote plugin catalog") &&
    (message.includes("authentication required") || message.includes("chatgpt"))
  ) {
    return true;
  }

  if (typeof cause === "object" && cause !== null && "cause" in cause) {
    return isRemotePluginCatalogAuthError((cause as { readonly cause?: unknown }).cause);
  }

  return false;
}

function remotePluginCatalogAuthLoadError(): ServerPluginsListResult["marketplaceLoadErrors"][number] {
  return {
    marketplacePath: "remote plugin catalog",
    message: "ChatGPT authentication is required to load Codex remote marketplace plugins.",
  };
}

function withCodexClient<A>(
  target: CodexManagementTarget,
  operation: string,
  useClient: (
    client: CodexClient.CodexAppServerClient["Service"],
  ) => Effect.Effect<A, CodexErrors.CodexAppServerError>,
): Effect.Effect<
  A,
  ServerPluginOperationError,
  ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
> {
  return Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const resolvedHomePath = expandHomePath(target.effectiveHomePath);
    const environment = {
      ...target.environment,
      CODEX_HOME: resolvedHomePath,
    };
    const spawnCommand = yield* resolveSpawnCommand(
      target.binaryPath,
      ["app-server", ...makeTritonAiCodexConfigArgs(environment)],
      {
        env: environment,
        extendEnv: true,
      },
    ).pipe(Effect.mapError((cause) => codexOperationError(operation, cause)));
    const child = yield* spawner
      .spawn(
        ChildProcess.make(spawnCommand.command, spawnCommand.args, {
          cwd: target.cwd,
          env: environment,
          extendEnv: true,
          forceKillAfter: CODEX_APP_SERVER_MANAGEMENT_FORCE_KILL_AFTER,
          shell: spawnCommand.shell,
        }),
      )
      .pipe(
        Effect.mapError((cause) =>
          codexOperationError(
            operation,
            new CodexErrors.CodexAppServerSpawnError({
              command: `${target.binaryPath} app-server`,
              cause,
            }),
          ),
        ),
      );
    const clientContext = yield* Layer.build(CodexClient.layerChildProcess(child)).pipe(
      Effect.mapError((cause) => codexOperationError(operation, cause)),
    );
    const client = yield* Effect.service(CodexClient.CodexAppServerClient).pipe(
      Effect.provide(clientContext),
    );

    yield* client
      .request("initialize", buildCodexInitializeParams())
      .pipe(Effect.mapError((cause) => codexOperationError(operation, cause)));
    yield* client
      .notify("initialized", undefined)
      .pipe(Effect.mapError((cause) => codexOperationError(operation, cause)));
    return yield* useClient(client).pipe(
      Effect.mapError((cause) => codexOperationError(operation, cause)),
    );
  });
}

export const listCodexPlugins = Effect.fn("listCodexPlugins")(function* (input?: {
  readonly includeRemote?: boolean;
  readonly instanceId?: ProviderInstanceId;
}) {
  const target = yield* resolveCodexManagementTarget(input?.instanceId);
  return yield* withCodexClient(target, "plugin/list", (client) =>
    client.request("plugin/list", {
      cwds: [target.cwd],
      ...(input?.includeRemote === false
        ? { marketplaceKinds: ["local", "workspace-directory"] as const }
        : {}),
    }),
  ).pipe(
    Effect.scoped,
    Effect.map(mapPluginListResponse),
    Effect.catchIf(isRemotePluginCatalogAuthError, () =>
      withCodexClient(target, "plugin/list", (client) =>
        client.request("plugin/list", {
          cwds: [target.cwd],
          marketplaceKinds: ["local", "workspace-directory"] as const,
        }),
      ).pipe(
        Effect.scoped,
        Effect.map((response) => {
          const result = mapPluginListResponse(response);
          return {
            ...result,
            marketplaceLoadErrors: [
              ...result.marketplaceLoadErrors,
              remotePluginCatalogAuthLoadError(),
            ],
          };
        }),
      ),
    ),
  );
});

const refreshProvidersAfterCodexMutation = Effect.fn("refreshProvidersAfterCodexMutation")(
  function* (instanceId: ProviderInstanceId) {
    const registry = yield* ProviderRegistry.ProviderRegistry;
    const providers = yield* registry.refreshInstance(instanceId);
    return { providers };
  },
);

export const installCodexPlugin = Effect.fn("installCodexPlugin")(function* (input: unknown) {
  const request = yield* decodePluginInstallInput(input).pipe(
    Effect.mapError((cause) => pluginError(`Plugin install request is invalid: ${schemaIssue(cause)}`, cause)),
  );
  const target = yield* resolveCodexManagementTarget();
  yield* withCodexClient(target, "plugin/install", (client) =>
    client.request("plugin/install", {
      pluginName: request.pluginName,
      ...(request.marketplacePath !== undefined ? { marketplacePath: request.marketplacePath } : {}),
      ...(request.remoteMarketplaceName !== undefined
        ? { remoteMarketplaceName: request.remoteMarketplaceName }
        : {}),
    }),
  ).pipe(Effect.scoped);
  yield* refreshProvidersAfterCodexMutation(target.instanceId);
  return yield* listCodexPlugins({ includeRemote: true, instanceId: target.instanceId });
});

export const uninstallCodexPlugin = Effect.fn("uninstallCodexPlugin")(function* (input: unknown) {
  const request = yield* decodePluginUninstallInput(input).pipe(
    Effect.mapError((cause) => pluginError(`Plugin uninstall request is invalid: ${schemaIssue(cause)}`, cause)),
  );
  const target = yield* resolveCodexManagementTarget();
  yield* withCodexClient(target, "plugin/uninstall", (client) =>
    client.request("plugin/uninstall", { pluginId: request.pluginId }),
  ).pipe(Effect.scoped);
  yield* refreshProvidersAfterCodexMutation(target.instanceId);
  return yield* listCodexPlugins({ includeRemote: true, instanceId: target.instanceId });
});

export const addCodexMarketplace = Effect.fn("addCodexMarketplace")(function* (input: unknown) {
  const request = yield* decodeMarketplaceAddInput(input).pipe(
    Effect.mapError((cause) => pluginError(`Marketplace add request is invalid: ${schemaIssue(cause)}`, cause)),
  );
  const target = yield* resolveCodexManagementTarget();
  yield* withCodexClient(target, "marketplace/add", (client) =>
    client.request("marketplace/add", {
      source: request.source,
      ...(request.refName !== undefined ? { refName: request.refName } : {}),
      ...(request.sparsePaths !== undefined ? { sparsePaths: request.sparsePaths } : {}),
    }),
  ).pipe(Effect.scoped);
  return yield* listCodexPlugins({ includeRemote: true, instanceId: target.instanceId });
});

export const removeCodexMarketplace = Effect.fn("removeCodexMarketplace")(function* (
  input: unknown,
) {
  const request = yield* decodeMarketplaceRemoveInput(input).pipe(
    Effect.mapError((cause) =>
      pluginError(`Marketplace remove request is invalid: ${schemaIssue(cause)}`, cause),
    ),
  );
  const target = yield* resolveCodexManagementTarget();
  yield* withCodexClient(target, "marketplace/remove", (client) =>
    client.request("marketplace/remove", { marketplaceName: request.marketplaceName }),
  ).pipe(Effect.scoped);
  return yield* listCodexPlugins({ includeRemote: true, instanceId: target.instanceId });
});

export const upgradeCodexMarketplace = Effect.fn("upgradeCodexMarketplace")(function* (
  input: unknown,
) {
  const request = yield* decodeMarketplaceUpgradeInput(input).pipe(
    Effect.mapError((cause) =>
      pluginError(`Marketplace upgrade request is invalid: ${schemaIssue(cause)}`, cause),
    ),
  );
  const target = yield* resolveCodexManagementTarget();
  yield* withCodexClient(target, "marketplace/upgrade", (client) =>
    client.request("marketplace/upgrade", {
      ...(request.marketplaceName !== undefined ? { marketplaceName: request.marketplaceName } : {}),
    }),
  ).pipe(Effect.scoped);
  return yield* listCodexPlugins({ includeRemote: true, instanceId: target.instanceId });
});

export const setCodexSkillEnabled = Effect.fn("setCodexSkillEnabled")(function* (input: unknown) {
  const request = yield* decodeSetSkillEnabledInput(input).pipe(
    Effect.mapError((cause) =>
      skillConfigError(`Skill config request is invalid: ${schemaIssue(cause)}`, cause),
    ),
  );
  if (!request.skillName && !request.skillPath) {
    return yield* skillConfigError("A skill name or path is required.");
  }
  const target = yield* resolveCodexManagementTarget(request.instanceId).pipe(
    Effect.mapError((cause) => skillConfigError(cause.message, cause)),
  );
  yield* withCodexClient(target, "skills/config/write", (client) =>
    client.request("skills/config/write", {
      enabled: request.enabled,
      ...(request.skillPath ? { path: request.skillPath } : {}),
      ...(!request.skillPath && request.skillName ? { name: request.skillName } : {}),
    }),
  ).pipe(
    Effect.scoped,
    Effect.mapError((cause) => skillConfigError(cause.message, cause)),
  );
  return yield* refreshProvidersAfterCodexMutation(target.instanceId);
});

export const installCodexProviderSkill = Effect.fn("installCodexProviderSkill")(function* (
  input: unknown,
) {
  const request = yield* decodeInstallSkillInput(input).pipe(
    Effect.mapError((cause) =>
      skillInstallError(`Skill install request is invalid: ${schemaIssue(cause)}`, cause),
    ),
  );
  const target = yield* resolveCodexManagementTarget(request.instanceId).pipe(
    Effect.mapError((cause) => skillInstallError(cause.message, cause)),
  );
  const path = yield* Path.Path;
  const result = yield* installProviderSkill({
    request,
    skillsDirectory: path.join(target.sharedHomePath, "skills"),
  });
  const { rollback, ...installResult } = result;
  yield* withCodexClient(target, "skills/config/write", (client) =>
    client.request("skills/config/write", {
      enabled: true,
      path: installResult.skillPath,
    }),
  ).pipe(
    Effect.scoped,
    Effect.mapError((cause) => skillInstallError(cause.message, cause)),
    Effect.catch((error) =>
      rollbackProviderSkillInstall(rollback).pipe(
        Effect.ignore,
        Effect.andThen(Effect.fail(error)),
      ),
    ),
  );
  yield* discardProviderSkillInstallRollback(rollback).pipe(Effect.ignore);
  const providers = yield* refreshProvidersAfterCodexMutation(target.instanceId);
  return {
    ...providers,
    ...installResult,
  };
});

export const removeCodexProviderSkill = Effect.fn("removeCodexProviderSkill")(function* (
  input: unknown,
) {
  const request = yield* decodeRemoveSkillInput(input).pipe(
    Effect.mapError((cause) =>
      skillInstallError(`Skill removal request is invalid: ${schemaIssue(cause)}`, cause),
    ),
  );
  const target = yield* resolveCodexManagementTarget(request.instanceId).pipe(
    Effect.mapError((cause) => skillInstallError(cause.message, cause)),
  );
  const registry = yield* ProviderRegistry.ProviderRegistry;
  const providers = yield* registry.getProviders;
  const removalTarget = yield* resolveProviderSkillRemovalTarget({ providers, request }).pipe(
    Effect.mapError((cause) => skillInstallError(cause.message, cause)),
  );
  yield* ensureSkillBelongsToCodexHome({
    provider: providers.find((candidate) => candidate.instanceId === request.instanceId),
    skillPath: request.skillPath,
    sharedHomePath: target.sharedHomePath,
  });
  yield* withCodexClient(target, "skills/config/write", (client) =>
    client.request("skills/config/write", {
      enabled: false,
      path: request.skillPath,
    }),
  ).pipe(
    Effect.scoped,
    Effect.mapError((cause) => skillInstallError(cause.message, cause)),
  );
  yield* removeProviderSkillFolder(removalTarget).pipe(
    Effect.mapError((cause) => skillInstallError(cause.message, cause)),
    Effect.catch((error) =>
      withCodexClient(target, "skills/config/write", (client) =>
        client.request("skills/config/write", {
          enabled: true,
          path: request.skillPath,
        }),
      ).pipe(Effect.scoped, Effect.ignore, Effect.andThen(Effect.fail(error))),
    ),
  );
  return yield* refreshProvidersAfterCodexMutation(target.instanceId);
});

const ensureSkillBelongsToCodexHome = Effect.fn("ensureSkillBelongsToCodexHome")(function* (input: {
  readonly provider: ServerProvider | undefined;
  readonly skillPath: string;
  readonly sharedHomePath: string;
}) {
  const path = yield* Path.Path;
  if (!input.provider) {
    return yield* skillInstallError("Provider was not found in the current provider inventory.");
  }
  const skill = input.provider.skills.find((candidate) => candidate.path === input.skillPath);
  if (!skill) {
    return yield* skillInstallError("Skill was not found in the current provider inventory.");
  }
  const normalizedSharedSkills = path.resolve(path.join(input.sharedHomePath, "skills"));
  const normalizedSkillPath = path.resolve(input.skillPath);
  if (!normalizedSkillPath.startsWith(`${normalizedSharedSkills}${path.sep}`)) {
    return yield* skillInstallError(
      "Only skills installed into TritonAI's managed Codex skills folder can be removed.",
    );
  }
});

export { listProviderSkillCatalog };
