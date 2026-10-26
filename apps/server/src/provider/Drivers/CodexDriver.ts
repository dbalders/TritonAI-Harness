/**
 * CodexDriver — first concrete `ProviderDriver` in the new per-instance model.
 *
 * A driver is a plain value (not a Context.Service) whose `create()` returns
 * one `ProviderInstance` bundling:
 *   - `snapshot`   — the live `ManagedServerProvider` for this instance;
 *   - `adapter`    — the Codex session/turn/approval runtime;
 *   - `textGeneration` — commit/PR/branch/title generation via `codex exec`.
 *
 * Each call to `create()` captures the `codexConfig` argument in closures
 * owned by the returned instance. Two instances created with different
 * `homePath`s (e.g. `codex_personal` + `codex_work`) therefore run with
 * fully independent Codex app-server processes and `CODEX_HOME`
 * environments — no shared mutable state.
 *
 * Resource lifecycle: `create()` runs in a scope handed in by the registry.
 * Closing that scope releases the adapter's child processes, the managed
 * snapshot's refresh fibre, and the text-generation binaries' transient
 * scratch files. The registry uses this to tear down an instance when its
 * `providerInstances` entry disappears or its config changes.
 *
 * @module provider/Drivers/CodexDriver
 */
import { CodexSettings, ProviderDriverKind } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as CodexUsageHistory from "../../usage/CodexUsageHistory.ts";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/http";
import { ChildProcessSpawner } from "effect/process";
import { makeCodexTextGeneration } from "../../textGeneration/CodexTextGeneration.ts";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as ServerConfig from "../../config.ts";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import {
  createCodexAdapterV2,
  type CodexAdapterV2DriverEnv,
} from "../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as ProcessRunner from "../../processRunner.ts";
import { ProviderDriverError } from "../Errors.ts";
import * as ResetCreditCoordinator from "../resetCreditCoordinator.ts";
import {
  checkCodexProviderStatus,
  makePendingCodexProvider,
  probeCodexSkillsForCwd,
  withCodexAppServerClient,
} from "../CodexProvider.ts";
import { resolveCodexLaunchArgs } from "../codexLaunchArgs.ts";
import { makeManagedServerProvider } from "@t3tools/provider-core/server/managedProvider";
import * as ModelCatalog from "@t3tools/provider-core/server/ModelCatalog";
import { applyCodexModelCatalog } from "../codexModelCatalog.ts";
import type { ProviderDriver, ProviderInstance } from "@t3tools/provider-core/server/driver";
import { withInstanceIdentity } from "@t3tools/provider-core/server/instanceIdentity";
import { mergeCodexProviderEnvironment } from "../CodexEnvironment.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  makeCachedProviderMaintenanceResolution,
  makePackageManagedProviderMaintenanceResolver,
  normalizeCommandPath,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "@t3tools/provider-core/server/maintenanceResolver";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "@t3tools/provider-core/server/snapshotSettings";
import {
  isTritonAiManagedCodexMaintenanceCapabilities,
  makeTritonAiManagedCodexMaintenanceResolver,
} from "../managedCodexUpdate.ts";
import {
  codexContinuationIdentity,
  materializeCodexShadowHome,
  resolveCodexHomeLayout,
} from "./CodexHomeLayout.ts";
import { materializeTritonAiCodexModelCatalog } from "./CodexModelCatalog.ts";
import { resolveManagedCodexBinary } from "../managedCodexRuntime.ts";
import { makeManagedCodexProvider } from "./CodexManagedProvider.ts";
import { codexUsageReader } from "./codexUsage.ts";
import * as CodexInstallation from "../CodexInstallation.ts";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";

const decodeCodexSettings = Schema.decodeSync(CodexSettings);

const DRIVER_KIND = ProviderDriverKind.make("codex");
// The standalone installer lays out `<CODEX_HOME>/packages/standalone/…`;
// CODEX_HOME is not always `~/.codex`.
function isCodexStandaloneCommandPath(commandPath: string): boolean {
  return normalizeCommandPath(commandPath).includes("/packages/standalone/");
}

/**
 * `codex update` replaces the standalone tree under `CODEX_HOME`. That tree
 * lives in the shared home even when an auth-overlay shadow home is in use
 * (the overlay only carries auth and a few local entries), so the updater
 * runs against `sharedHomePath` rather than the instance's effective home.
 */
function makeCodexMaintenanceResolver(sharedHomePath: string) {
  const fallback = makePackageManagedProviderMaintenanceResolver({
    provider: DRIVER_KIND,
    npmPackageName: "@openai/codex",
    nativeUpdate: {
      args: ["update"],
      isCommandPath: isCodexStandaloneCommandPath,
      env: { CODEX_HOME: sharedHomePath },
    },
  });
  return makeTritonAiManagedCodexMaintenanceResolver({
    provider: DRIVER_KIND,
    packageName: "@openai/codex",
    fallback,
    executablePath: process.execPath,
    serverEntryPath: process.argv[1] ?? "",
  });
}

/**
 * Services the driver needs to materialize an instance. Surfaced as the
 * driver's `R` so the registry layer aggregates these across every
 * registered driver and the runtime satisfies them once.
 */
export type CodexDriverEnv =
  | CodexAdapterV2DriverEnv
  | ProviderHost.ProviderHost
  | ChildProcessSpawner.ChildProcessSpawner
  | ResetCreditCoordinator.ResetCreditCoordinator
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | ProviderLatestVersions.ProviderLatestVersions
  | ModelCatalog.ModelCatalog
  | Path.Path
  | ProviderEventLoggers.ProviderEventLoggers
  | ServerConfig.ServerConfig
  | ServerSecretStore.ServerSecretStore
  | ServerEnvironment.ServerEnvironmentIdentity
  | CodexInstallation.CodexInstallation;

export const CodexDriver: ProviderDriver<
  CodexSettings,
  CodexDriverEnv,
  Path.Path | CodexUsageHistory.CodexUsageHistory
> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Codex",
    supportsMultipleInstances: true,
  },
  configSchema: CodexSettings,
  defaultConfig: (): CodexSettings => decodeCodexSettings({}),
  usage: codexUsageReader,
  create: Effect.fn("CodexDriver.create")(function* ({
    instanceId,
    displayName,
    accentColor,
    environment,
    enabled,
    config,
  }) {
    if (config.setupMode === "managed")
      return yield* makeManagedCodexProvider({
        instanceId,
        displayName,
        accentColor,
        environment,
        enabled,
        config,
      });
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const processRunner = yield* ProcessRunner.make();
    const resetCreditCoordinator = yield* ResetCreditCoordinator.ResetCreditCoordinator;
    const fileSystem = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    const httpClient = yield* HttpClient.HttpClient;
    const latestVersions = yield* ProviderLatestVersions.ProviderLatestVersions;
    const modelCatalog = yield* ModelCatalog.ModelCatalog;
    const currentCatalog = modelCatalog.current(DRIVER_KIND);
    const path = yield* Path.Path;
    const serverConfig = yield* ServerConfig.ServerConfig;
    const hostPlatform = yield* HostProcess.Platform;
    const processEnv = yield* mergeCodexProviderEnvironment(
      environment,
      yield* HostProcess.Environment,
      hostPlatform,
      String(instanceId),
    );
    const configuredHomePath = config.homePath.trim();
    const binaryPath = enabled
      ? yield* resolveManagedCodexBinary({
          binaryPath: expandHomePath(config.binaryPath, yield* HostProcess.HomeDirectory),
          homeDirectory: yield* HostProcess.HomeDirectory,
          platform: hostPlatform,
          environment: processEnv,
          run: processRunner.run,
        }).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderDriverError({
                driver: DRIVER_KIND,
                instanceId,
                detail: cause.message,
                cause,
              }),
          ),
        )
      : expandHomePath(config.binaryPath, yield* HostProcess.HomeDirectory);
    const managedConfig = {
      ...config,
      binaryPath,
      homePath:
        configuredHomePath.length > 0 ? config.homePath : path.join(serverConfig.baseDir, "codex"),
    } satisfies CodexSettings;
    const homeLayout = yield* resolveCodexHomeLayout(managedConfig);
    const isManagedGateway =
      ["codex", "codex_frontier"].includes(String(instanceId)) &&
      environment?.some((variable) => variable.name.toUpperCase() === "TRITONAI_API_KEY_SOURCE") ===
        true;
    // Managed gateways share runtime files, but their models cannot consume
    // each other's native history. Route changes must use a portable handoff.
    const continuationIdentity = {
      ...codexContinuationIdentity(homeLayout),
      ...(isManagedGateway
        ? { continuationKey: `${homeLayout.continuationKey}:tritonai:${instanceId}` }
        : {}),
      ...(config.sessionPurpose === "integrations"
        ? {
            continuationKey: `${homeLayout.continuationKey}:${isManagedGateway ? `tritonai:${instanceId}:` : ""}integrations-v1`,
          }
        : {}),
    };
    const stampIdentity = withInstanceIdentity({
      instanceId,
      driverKind: DRIVER_KIND,
      displayName,
      accentColor,
      continuationGroupKey: continuationIdentity.continuationKey,
    });
    yield* materializeCodexShadowHome(homeLayout).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: DRIVER_KIND,
            instanceId,
            detail: cause.message,
            cause,
          }),
      ),
    );
    // Keep the resolved executable from `managedConfig`: a bare `codex`
    // resolves to the TritonAI-managed runtime above, and every spawn below
    // (catalog read, status probe, app-server) must use that result.
    const effectiveConfig = {
      ...managedConfig,
      enabled,
      homePath: homeLayout.effectiveHomePath ?? "",
    } satisfies CodexSettings;
    const modelCatalogPath = yield* materializeTritonAiCodexModelCatalog({
      binaryPath: effectiveConfig.binaryPath,
      homePath: effectiveConfig.homePath || homeLayout.sharedHomePath,
      catalogKey: instanceId,
      environment: processEnv,
      customModelMetadata: enabled ? effectiveConfig.customModelMetadata : {},
      managedGateway: enabled && isManagedGateway,
    }).pipe(
      Effect.provideService(ProcessRunner.ProcessRunner, processRunner),
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: DRIVER_KIND,
            instanceId,
            detail: cause.message,
            cause,
          }),
      ),
    );
    const resolveMaintenance = yield* makeCachedProviderMaintenanceResolution(
      resolveProviderMaintenanceCapabilitiesEffect(
        makeCodexMaintenanceResolver(homeLayout.sharedHomePath),
        {
          binaryPath: effectiveConfig.binaryPath,
          env: processEnv,
        },
      ).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, pathService),
      ),
    );

    const orchestrationAdapter = yield* createCodexAdapterV2(
      {
        instanceId,
        displayName,
        accentColor,
        environment,
        enabled,
        config: managedConfig,
      },
      {
        onUsageLimits: (update) => snapshot.applyUsageLimits(update),
        ...(modelCatalogPath ? { modelCatalogPath } : {}),
        ...(isManagedGateway
          ? {
              allowedModels: effectiveConfig.customModels.map((model) =>
                typeof model === "string" ? model : model.slug,
              ),
            }
          : {}),
      },
    ).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: DRIVER_KIND,
            instanceId,
            detail: "Failed to build Codex orchestration adapter.",
            cause,
          }),
      ),
    );

    // Build a managed snapshot whose settings never change — mutations come
    // in as instance rebuilds from the registry rather than in-place
    // updates. Pre-provide `ChildProcessSpawner` so the check fits
    // `makeManagedServerProvider.checkProvider`'s `R = never`.
    // Kick the TTL-gated manifest refresh in the background and classify
    // with the in-memory manifest, so a slow or hung fetch never delays the
    // provider check. A refresh that lands mid-probe applies on the next one.
    const checkProvider = modelCatalog.refreshInBackground.pipe(
      Effect.andThen(
        Effect.zipWith(
          checkCodexProviderStatus(
            effectiveConfig,
            undefined,
            processEnv,
            ["codex", "codex_frontier"].includes(String(instanceId)) &&
              environment?.some(
                (variable) => variable.name.toUpperCase() === "TRITONAI_API_KEY_SOURCE",
              ) &&
              processEnv.TRITONAI_API_KEY?.trim()
              ? { status: "authenticated", type: "apiKey", label: "TritonAI access key" }
              : undefined,
          ),
          currentCatalog,
          (draft, catalog) => stampIdentity(applyCodexModelCatalog(draft, catalog)),
          { concurrent: true },
        ),
      ),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, pathService),
    );
    const snapshotSettings = yield* makeProviderSnapshotSettingsSource(effectiveConfig);
    const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<CodexSettings>>({
      resolveMaintenance,
      getSettings: snapshotSettings.getSettings,
      streamSettings: snapshotSettings.streamSettings,
      haveSettingsChanged: haveProviderSnapshotSettingsChanged,
      initialSnapshot: (settings) =>
        Effect.zipWith(
          makePendingCodexProvider(settings.provider),
          currentCatalog,
          (draft, catalog) => stampIdentity(applyCodexModelCatalog(draft, catalog)),
        ),
      checkProvider,
      enrichSnapshot: ({ settings, snapshot, publishSnapshot }) =>
        resolveMaintenance().pipe(
          Effect.flatMap((maintenanceCapabilities) =>
            enrichProviderSnapshotWithVersionAdvisory(snapshot, maintenanceCapabilities, {
              enableProviderUpdateChecks:
                isTritonAiManagedCodexMaintenanceCapabilities(maintenanceCapabilities) ||
                settings.enableProviderUpdateChecks,
            }),
          ),
          Effect.provideService(HttpClient.HttpClient, httpClient),
          Effect.provideService(ProviderLatestVersions.ProviderLatestVersions, latestVersions),
          Effect.flatMap((enrichedSnapshot) => publishSnapshot(enrichedSnapshot)),
        ),
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: DRIVER_KIND,
            instanceId,
            detail: `Failed to build Codex snapshot: ${cause.message ?? String(cause)}`,
            cause,
          }),
      ),
    );
    const textGeneration = yield* makeCodexTextGeneration(
      effectiveConfig,
      processEnv,
      snapshot.getSnapshot.pipe(Effect.map((value) => value.models)),
      undefined,
      modelCatalogPath ? { modelCatalogPath } : undefined,
    );
    const snapshotForCwd = (cwd: string) =>
      !effectiveConfig.enabled
        ? snapshot.getSnapshot
        : Effect.all([
            snapshot.getSnapshot,
            probeCodexSkillsForCwd({
              binaryPath: effectiveConfig.binaryPath,
              homePath: effectiveConfig.homePath,
              launchArgs: resolveCodexLaunchArgs(effectiveConfig.launchArgs, processEnv),
              cwd,
              environment: processEnv,
            }).pipe(
              Effect.scoped,
              Effect.timeout("20 seconds"),
              Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
            ),
          ]).pipe(
            Effect.map(([machineSnapshot, skills]) => ({ ...machineSnapshot, skills })),
            Effect.mapError(
              (cause) =>
                new ProviderDriverError({
                  driver: DRIVER_KIND,
                  instanceId,
                  detail: `Failed to probe Codex skills for '${cwd}'`,
                  cause,
                }),
            ),
          );

    // Redemption spends something on the user's account. It serialises on
    // the account (instances sharing a Codex home share the credit), keeps
    // one idempotency key until Codex reports an outcome, and is bounded so
    // a hung app-server cannot hold the account lock.
    // Keyed on the directory holding auth.json: an auth-overlay instance has
    // its own account under `effectiveHomePath`, while plain instances share
    // the common home. The continuation key would conflate the two.
    const accountKey = homeLayout.effectiveHomePath ?? homeLayout.sharedHomePath;
    const consumeResetCredit: NonNullable<ProviderInstance["consumeResetCredit"]> = () =>
      resetCreditCoordinator
        .redeem(accountKey, (idempotencyKey) =>
          Effect.gen(function* () {
            const { client } = yield* withCodexAppServerClient({
              binaryPath: effectiveConfig.binaryPath,
              homePath: effectiveConfig.homePath,
              launchArgs: resolveCodexLaunchArgs(effectiveConfig.launchArgs, processEnv),
              // Account-level request; any directory serves, same as the status probe.
              cwd: process.cwd(),
              environment: processEnv,
            });
            const response = yield* client.request("account/rateLimitResetCredit/consume", {
              idempotencyKey,
            });
            return response.outcome;
          }).pipe(Effect.scoped, Effect.timeout("20 seconds")),
        )
        .pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.mapError(
            (cause) =>
              new ProviderDriverError({
                driver: DRIVER_KIND,
                instanceId,
                detail: "Codex could not redeem the reset credit.",
                cause,
              }),
          ),
          // The windows just changed; re-probe so the snapshot says so. A
          // failed probe republishes the pre-redemption limits rather than
          // marking them failed, so "confirmed" means `checkedAt` moved
          // past what was published before the redemption started. Only a
          // reset claims the limits changed, so only a reset reports an
          // unconfirmed refresh.
          Effect.tap((outcome) =>
            Effect.gen(function* () {
              const before = (yield* snapshot.getSnapshot).usageLimits?.checkedAt;
              const refreshed = yield* snapshot.refresh;
              const after = refreshed.usageLimits?.checkedAt;
              if (
                outcome === "reset" &&
                (after === undefined ||
                  after === before ||
                  refreshed.usageLimits?.unavailable?.reason === "probeFailed")
              ) {
                return yield* new ProviderDriverError({
                  driver: DRIVER_KIND,
                  instanceId,
                  detail:
                    "The reset was applied, but Codex could not confirm the new limits. Refresh to check.",
                });
              }
            }),
          ),
        );

    return {
      instanceId,
      driverKind: DRIVER_KIND,
      continuationIdentity,
      displayName,
      accentColor,
      enabled,
      snapshot,
      snapshotForCwd,
      consumeResetCredit,
      orchestrationAdapter,
      textGeneration,
    } satisfies ProviderInstance;
  }),
};
