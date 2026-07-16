import {
  type EnvironmentId,
  type ServerConfig,
  type ServerConfigStreamEvent,
  type ServerLifecycleWelcomePayload,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";

export interface ServerConfigProjection {
  readonly config: ServerConfig;
  readonly latestEvent: ServerConfigStreamEvent;
}

export function applyServerConfigProjection(
  current: Option.Option<ServerConfigProjection>,
  event: ServerConfigStreamEvent,
): Option.Option<ServerConfigProjection> {
  switch (event.type) {
    case "snapshot":
      return Option.some({
        config: event.config,
        latestEvent: event,
      });
    case "keybindingsUpdated":
      return Option.map(current, (projection) => ({
        config: {
          ...projection.config,
          keybindings: event.payload.keybindings,
          issues: event.payload.issues,
        },
        latestEvent: event,
      }));
    case "providerStatuses":
      return Option.map(current, (projection) => ({
        config: {
          ...projection.config,
          providers: event.payload.providers,
        },
        latestEvent: event,
      }));
    case "settingsUpdated":
      return Option.map(current, (projection) => ({
        config: {
          ...projection.config,
          settings: event.payload.settings,
        },
        latestEvent: event,
      }));
  }
}

export function projectServerConfig(
  current: Option.Option<ServerConfigProjection>,
  event: ServerConfigStreamEvent,
): readonly [Option.Option<ServerConfigProjection>, ReadonlyArray<ServerConfigProjection>] {
  const next = applyServerConfigProjection(current, event);
  return [next, Option.toArray(next)];
}

export function projectServerWelcome(
  current: Option.Option<ServerLifecycleWelcomePayload>,
  event: {
    readonly type: "welcome" | "ready";
    readonly payload: unknown;
  },
): readonly [
  Option.Option<ServerLifecycleWelcomePayload>,
  ReadonlyArray<ServerLifecycleWelcomePayload>,
] {
  if (event.type !== "welcome") {
    return [current, []];
  }
  const welcome = event.payload as ServerLifecycleWelcomePayload;
  return [Option.some(welcome), [welcome]];
}

export function createServerEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
  options: {
    readonly initialConfigValueAtom: (
      environmentId: EnvironmentId,
    ) => Atom.Atom<ServerConfig | null>;
  },
) {
  const configScheduler = createAtomCommandScheduler();
  const configConcurrency = {
    mode: "serial" as const,
    key: ({ environmentId }: { readonly environmentId: string }) => environmentId,
  };
  const configProjection = createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "environment-data:server:config-projection",
    tag: WS_METHODS.subscribeServerConfig,
    transform: (stream) =>
      stream.pipe(Stream.mapAccum(Option.none<ServerConfigProjection>, projectServerConfig)),
  });
  const emptyConfigAtom = Atom.make<ServerConfig | null>(null).pipe(
    Atom.withLabel("environment-data:server:config:empty"),
  );
  const configValueAtom = Atom.family((environmentId: EnvironmentId | null) => {
    if (environmentId === null) {
      return emptyConfigAtom;
    }
    return Atom.make((get): ServerConfig | null => {
      const projection = Option.getOrNull(
        AsyncResult.value(get(configProjection({ environmentId, input: {} }))),
      );
      return projection?.config ?? get(options.initialConfigValueAtom(environmentId));
    }).pipe(Atom.withLabel(`environment-data:server:config:${environmentId}`));
  });
  const settingsValueAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => get(configValueAtom(environmentId))?.settings ?? null).pipe(
      Atom.withLabel(`environment-data:server:settings:${environmentId}`),
    ),
  );
  const providersValueAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => get(configValueAtom(environmentId))?.providers ?? null).pipe(
      Atom.withLabel(`environment-data:server:providers:${environmentId}`),
    ),
  );

  return {
    configValueAtom,
    settingsValueAtom,
    providersValueAtom,
    traceDiagnostics: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:server:trace-diagnostics",
      tag: WS_METHODS.serverGetTraceDiagnostics,
    }),
    processDiagnostics: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:server:process-diagnostics",
      tag: WS_METHODS.serverGetProcessDiagnostics,
    }),
    tritonAiUsage: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:server:tritonai-usage",
      tag: WS_METHODS.serverGetTritonAiUsage,
    }),
    processResourceHistory: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:server:process-resource-history",
      tag: WS_METHODS.serverGetProcessResourceHistory,
    }),
    configProjection,
    welcome: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:server:welcome",
      tag: WS_METHODS.subscribeServerLifecycle,
      transform: (stream) =>
        stream.pipe(
          Stream.mapAccum(Option.none<ServerLifecycleWelcomePayload>, projectServerWelcome),
        ),
    }),
    refreshProviders: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:refresh-providers",
      tag: WS_METHODS.serverRefreshProviders,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId }) => environmentId,
      },
    }),
    updateProvider: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:update-provider",
      tag: WS_METHODS.serverUpdateProvider,
      scheduler: configScheduler,
      concurrency: configConcurrency,
    }),
    upsertKeybinding: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:upsert-keybinding",
      tag: WS_METHODS.serverUpsertKeybinding,
      scheduler: configScheduler,
      concurrency: configConcurrency,
    }),
    removeKeybinding: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:remove-keybinding",
      tag: WS_METHODS.serverRemoveKeybinding,
      scheduler: configScheduler,
      concurrency: configConcurrency,
    }),
    updateSettings: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:update-settings",
      tag: WS_METHODS.serverUpdateSettings,
      scheduler: configScheduler,
      concurrency: configConcurrency,
    }),
    transcribeVoice: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:transcribe-voice",
      tag: WS_METHODS.serverTranscribeVoice,
    }),
    signalProcess: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:signal-process",
      tag: WS_METHODS.serverSignalProcess,
    }),
    listProviderSkillCatalog: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:list-provider-skill-catalog",
      tag: WS_METHODS.serverListProviderSkillCatalog,
    }),
    installProviderSkill: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:install-provider-skill",
      tag: WS_METHODS.serverInstallProviderSkill,
      scheduler: configScheduler,
      concurrency: configConcurrency,
    }),
    removeProviderSkill: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:remove-provider-skill",
      tag: WS_METHODS.serverRemoveProviderSkill,
      scheduler: configScheduler,
      concurrency: configConcurrency,
    }),
    setProviderSkillEnabled: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:set-provider-skill-enabled",
      tag: WS_METHODS.serverSetProviderSkillEnabled,
      scheduler: configScheduler,
      concurrency: configConcurrency,
    }),
    listPlugins: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:list-plugins",
      tag: WS_METHODS.serverListPlugins,
    }),
    installPlugin: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:install-plugin",
      tag: WS_METHODS.serverInstallPlugin,
    }),
    uninstallPlugin: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:uninstall-plugin",
      tag: WS_METHODS.serverUninstallPlugin,
    }),
    addMarketplace: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:add-marketplace",
      tag: WS_METHODS.serverAddMarketplace,
    }),
    removeMarketplace: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:remove-marketplace",
      tag: WS_METHODS.serverRemoveMarketplace,
    }),
    upgradeMarketplace: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:upgrade-marketplace",
      tag: WS_METHODS.serverUpgradeMarketplace,
    }),
    listIntegrations: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:integrations:list",
      tag: WS_METHODS.integrationsList,
    }),
    installIntegration: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:integrations:install",
      tag: WS_METHODS.integrationsInstall,
      scheduler: configScheduler,
      concurrency: configConcurrency,
    }),
    setIntegrationEnabled: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:integrations:set-enabled",
      tag: WS_METHODS.integrationsSetEnabled,
      scheduler: configScheduler,
      concurrency: configConcurrency,
    }),
    setIntegrationSkillEnabled: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:integrations:set-skill-enabled",
      tag: WS_METHODS.integrationsSetSkillEnabled,
      scheduler: configScheduler,
      concurrency: configConcurrency,
    }),
    connectIntegration: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:integrations:connect",
      tag: WS_METHODS.integrationsConnect,
    }),
    pollIntegration: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:integrations:poll",
      tag: WS_METHODS.integrationsPoll,
    }),
    disconnectIntegration: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:integrations:disconnect",
      tag: WS_METHODS.integrationsDisconnect,
      scheduler: configScheduler,
      concurrency: configConcurrency,
    }),
  };
}
