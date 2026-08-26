/**
 * CodexDriver — first concrete `ProviderDriver` in the new per-instance model.
 *
 * A driver is a plain value (not a Context.Service) whose `create()` returns
 * one `ProviderInstance` bundling:
 *   - `snapshot`   — the live `ServerProviderShape` for this instance;
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
import {
  CodexSettings,
  ProviderDriverKind,
  type ProviderInstanceEnvironment,
  type ServerProvider,
  TRITONAI_API_KEY_ENV,
  TRITONAI_API_KEY_SOURCE_ENV,
  TRITONAI_FRONTIER_API_KEY_ENV,
  TRITONAI_FRONTIER_PROVIDER_INSTANCE_ID,
  TRITONAI_ONPREM_API_KEY_ENV,
  TRITONAI_ONPREM_PROVIDER_INSTANCE_ID,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import { makeCodexTextGeneration } from "../../textGeneration/CodexTextGeneration.ts";
import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import * as ProcessRunner from "../../processRunner.ts";
import * as PreviewAutomationBroker from "../../mcp/PreviewAutomationBroker.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeCodexAdapter } from "../Layers/CodexAdapter.ts";
import { checkCodexProviderStatus, makePendingCodexProvider } from "../Layers/CodexProvider.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import * as ModelManifest from "../ModelManifest.ts";
import type { ProviderDriver, ProviderInstance } from "../ProviderDriver.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";
import {
  mergeProviderInstanceEnvironment,
  withoutInheritedCodexNetworkSandboxMarker,
} from "../ProviderInstanceEnvironment.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  makePackageManagedProviderMaintenanceResolver,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "../providerMaintenance.ts";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "../providerUpdateSettings.ts";
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
const decodeCodexSettings = Schema.decodeSync(CodexSettings);

const DRIVER_KIND = ProviderDriverKind.make("codex");
const PACKAGE_UPDATE = makePackageManagedProviderMaintenanceResolver({
  provider: DRIVER_KIND,
  npmPackageName: "@openai/codex",
  homebrewFormula: "codex",
  nativeUpdate: null,
});
const UPDATE = makeTritonAiManagedCodexMaintenanceResolver({
  provider: DRIVER_KIND,
  packageName: "@openai/codex",
  fallback: PACKAGE_UPDATE,
  executablePath: process.execPath,
  serverEntryPath: process.argv[1] ?? "",
});

export function mergeCodexProviderEnvironment(
  environment: ProviderInstanceEnvironment | undefined,
  baseEnv: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  instanceId: string,
): NodeJS.ProcessEnv {
  const requestedSourceName = environment?.find(
    (variable) => variable.name.toUpperCase() === TRITONAI_API_KEY_SOURCE_ENV,
  )?.value;
  const credentialEnvironmentNames = new Set(
    [
      TRITONAI_API_KEY_ENV,
      TRITONAI_API_KEY_SOURCE_ENV,
      TRITONAI_ONPREM_API_KEY_ENV,
      TRITONAI_FRONTIER_API_KEY_ENV,
    ].map((name) => name.toUpperCase()),
  );
  const expectedSourceName =
    instanceId === TRITONAI_ONPREM_PROVIDER_INSTANCE_ID
      ? TRITONAI_ONPREM_API_KEY_ENV
      : instanceId === TRITONAI_FRONTIER_PROVIDER_INSTANCE_ID
        ? TRITONAI_FRONTIER_API_KEY_ENV
        : undefined;
  const sourceName = requestedSourceName?.trim();
  const isManagedRoute = expectedSourceName !== undefined && sourceName === expectedSourceName;
  // Process-level TritonAI credentials are Installer-managed in this
  // distribution. A personal Codex instance can opt in only by configuring
  // its own key explicitly; it must never inherit a managed shared or route key.
  const inheritedEnvironment = Object.fromEntries(
    Object.entries(withoutInheritedCodexNetworkSandboxMarker(baseEnv, platform)).filter(
      ([name]) => !credentialEnvironmentNames.has(name.toUpperCase()),
    ),
  );
  const merged = mergeProviderInstanceEnvironment(
    environment?.filter((variable) =>
      isManagedRoute
        ? !credentialEnvironmentNames.has(variable.name.toUpperCase())
        : variable.name.toUpperCase() !== TRITONAI_API_KEY_SOURCE_ENV,
    ),
    inheritedEnvironment,
    platform,
  );
  const environmentValue = (name: string | undefined): string | undefined => {
    if (!name) return undefined;
    const entry = Object.entries(baseEnv).find(([candidate]) =>
      platform === "win32" ? candidate.toUpperCase() === name.toUpperCase() : candidate === name,
    );
    const value = entry?.[1]?.trim();
    return value && value.length > 0 ? value : undefined;
  };
  const managedTritonAiApiKey = isManagedRoute
    ? (environmentValue(TRITONAI_API_KEY_ENV) ?? environmentValue(expectedSourceName))
    : undefined;
  if (!managedTritonAiApiKey) return merged;

  // A shared desktop replacement remains authoritative. Otherwise the managed
  // route selects one backend credential and exposes only that value to this
  // Codex child process.
  return mergeProviderInstanceEnvironment(
    [
      {
        name: TRITONAI_API_KEY_ENV,
        value: managedTritonAiApiKey,
        sensitive: true,
      },
    ],
    merged,
    platform,
  );
}

/**
 * Services the driver needs to materialize an instance. Surfaced as the
 * driver's `R` so the registry layer aggregates these across every
 * registered driver and the runtime satisfies them once.
 */
export type CodexDriverEnv =
  | BackgroundPolicy.BackgroundPolicy
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | ModelManifest.ModelManifest
  | Path.Path
  | ProviderEventLoggers
  | ServerConfig
  | ServerSettingsService;

/**
 * Stamp instance identity onto a `ServerProvider` snapshot produced by the
 * driver-kind-only codex helpers. Once `buildServerProvider` in
 * `providerSnapshot.ts` is widened to accept `instanceId`/`driver`, this
 * wrapper disappears.
 */
const withInstanceIdentity =
  (input: {
    readonly instanceId: ProviderInstance["instanceId"];
    readonly displayName: string | undefined;
    readonly accentColor: string | undefined;
    readonly continuationGroupKey: string;
  }) =>
  (snapshot: ServerProviderDraft): ServerProvider => ({
    ...snapshot,
    instanceId: input.instanceId,
    driver: DRIVER_KIND,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    continuation: { groupKey: input.continuationGroupKey },
  });

export const CodexDriver: ProviderDriver<CodexSettings, CodexDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Codex",
    supportsMultipleInstances: true,
  },
  configSchema: CodexSettings,
  defaultConfig: (): CodexSettings => decodeCodexSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const processRunner = yield* ProcessRunner.make();
      const httpClient = yield* HttpClient.HttpClient;
      const path = yield* Path.Path;
      const serverConfig = yield* ServerConfig;
      const serverSettings = yield* ServerSettingsService;
      const eventLoggers = yield* ProviderEventLoggers;
      const previewAutomationBroker = yield* Effect.serviceOption(
        PreviewAutomationBroker.PreviewAutomationBroker,
      );
      const hostPlatform = yield* HostProcessPlatform;
      const processEnv = mergeCodexProviderEnvironment(
        environment,
        process.env,
        hostPlatform,
        String(instanceId),
      );
      const configuredHomePath = config.homePath.trim();
      const managedConfig = {
        ...config,
        homePath:
          configuredHomePath.length > 0
            ? config.homePath
            : path.join(serverConfig.baseDir, "codex"),
      } satisfies CodexSettings;
      const homeLayout = yield* resolveCodexHomeLayout(managedConfig);
      const continuationIdentity = codexContinuationIdentity(homeLayout);
      const stampIdentity = withInstanceIdentity({
        instanceId,
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
      const maintenanceCapabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(UPDATE, {
        binaryPath: effectiveConfig.binaryPath,
        env: processEnv,
      });

      // `makeCodexAdapter` and `makeCodexTextGeneration` have `never` error
      // channels at construction time — their failure modes are all on the
      // per-operation closures they return. No `mapError` wrapper is needed
      // here; the registry only has to worry about snapshot-build and
      // spawner-availability failures surfaced from `checkCodexProviderStatus`
      // below.
      const adapter = yield* makeCodexAdapter(effectiveConfig, {
        instanceId,
        environment: processEnv,
        ...(modelCatalogPath ? { modelCatalogPath } : {}),
        ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
        ...(Option.isSome(previewAutomationBroker)
          ? { previewAutomationBroker: previewAutomationBroker.value }
          : {}),
      });
      const textGeneration = yield* makeCodexTextGeneration(
        effectiveConfig,
        processEnv,
        modelCatalogPath ? { modelCatalogPath } : {},
      );

      // Build a managed snapshot whose settings never change — mutations come
      // in as instance rebuilds from the registry rather than in-place
      // updates. Pre-provide `ChildProcessSpawner` so the check fits
      // `makeManagedServerProvider.checkProvider`'s `R = never`.
      // Kick the TTL-gated manifest refresh in the background and classify
      // with the in-memory manifest, so a slow or hung fetch never delays the
      // provider check. A refresh that lands mid-probe applies on the next one.
      const checkProvider = modelManifest.refreshInBackground.pipe(
        Effect.andThen(
          Effect.zipWith(
            checkCodexProviderStatus(effectiveConfig, undefined, processEnv),
            modelManifest.current,
            (draft, manifest) =>
              stampIdentity(ModelManifest.applyModelManifest(draft, manifest, DRIVER_KIND)),
            { concurrent: true },
          ),
        ),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
      const snapshotSettings = makeProviderSnapshotSettingsSource(effectiveConfig, serverSettings);
      const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<CodexSettings>>({
        maintenanceCapabilities,
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (settings) =>
          Effect.zipWith(
            makePendingCodexProvider(settings.provider),
            modelManifest.current,
            (draft, manifest) =>
              stampIdentity(ModelManifest.applyModelManifest(draft, manifest, DRIVER_KIND)),
          ),
        checkProvider,
        enrichSnapshot: ({ settings, snapshot, publishSnapshot }) =>
          enrichProviderSnapshotWithVersionAdvisory(snapshot, maintenanceCapabilities, {
            enableProviderUpdateChecks:
              isTritonAiManagedCodexMaintenanceCapabilities(maintenanceCapabilities) ||
              settings.enableProviderUpdateChecks,
          }).pipe(
            Effect.provideService(HttpClient.HttpClient, httpClient),
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

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        adapter,
        textGeneration,
      } satisfies ProviderInstance;
    }),
};
