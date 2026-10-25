import {
  HelpAskInput,
  type HelpAskResult,
  type HelpContext,
  type HelpClientContext,
  type ServerSettings as HostSettings,
  HelpError,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerConfig from "../config.ts";
import * as TraceDiagnostics from "../diagnostics/TraceDiagnostics.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import { sanitizeHelpClient } from "./HelpClient.ts";
import * as HelpDocumentation from "./HelpDocumentation.ts";
import * as HelpIntegrations from "./HelpIntegrations.ts";
import { buildHelpPluginSnapshot } from "./HelpPlugins.ts";
import { redactHelpText as redact, safeHelpText as safeText } from "./HelpSafety.ts";
import { helpSettingsSnapshot } from "./HelpSettings.ts";

export class Help extends Context.Service<
  Help,
  {
    readonly getContext: Effect.Effect<HelpContext, HelpError>;
    readonly ask: (input: HelpAskInput) => Effect.Effect<HelpAskResult, HelpError>;
  }
>()("t3/help/Help") {}

// Only exact known operation names leave the server. Trace names and causes may contain
// arguments, paths, prompts or credentials, even when a name looks like an identifier.
const operations = new Set<string>([
  ...Object.values(WS_METHODS),
  ...Object.values(WS_METHODS).map((method) => `rpc.${method}`),
  ...Object.values(WS_METHODS).map((method) => `ws.rpc.${method}`),
  "ProviderRegistry.refresh",
  "ProviderRegistry.refreshInstance",
  "ProviderSessionManager.sendTurn",
  "CodexAdapter.sendTurn",
  "TextGeneration.generateHelp",
  "TraceDiagnostics.read",
]);
const operationName = (value: string): string => (operations.has(value) ? value : "other");
const decodeHelpInput = Schema.decodeEffect(HelpAskInput);

const failureCategory = (cause: string): string => {
  if (/timeout|timed out/i.test(cause)) return "timeout";
  if (/unauthenticated|authentication|unauthorized|invalid.?token|expired.?token|401/i.test(cause))
    return "authentication";
  if (/rate.?limit|too many requests|429/i.test(cause)) return "rate_limit";
  if (/permission|forbidden|access.?denied|403/i.test(cause)) return "permission";
  if (/econn|enotfound|network|fetch failed|connection|socket/i.test(cause)) return "connection";
  if (/unavailable|not.?found|enoent|not installed/i.test(cause)) return "unavailable";
  if (/interrupt|cancel/i.test(cause)) return "interrupted";
  return "failure";
};

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const providers = yield* ProviderRegistry.ProviderRegistry;
  const instances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const diagnostics = yield* TraceDiagnostics.TraceDiagnostics;
  const textGeneration = yield* TextGeneration.TextGeneration;
  const fileSystem = yield* FileSystem.FileSystem;
  const integrations = yield* HelpIntegrations.HelpIntegrations;
  const documentation = yield* HelpDocumentation.HelpDocumentation;
  // One inference at a time per environment, with no queue or background work.
  const budget = yield* Semaphore.make(1);

  const readSettings = settingsService.getSettings.pipe(
    Effect.mapError(() => new HelpError({ code: "unavailable" })),
  );

  const contextFor = Effect.fn("Help.contextFor")(function* (
    settings: HostSettings,
    question = "",
    client?: HelpClientContext,
    recentDocumentationContext = "",
  ): Effect.fn.Return<HelpContext> {
    const modelSelection = settings.textGenerationModelSelection;
    const descriptor = yield* environment.getDescriptor;
    const configured = yield* settingsService.getPersistedSettings.pipe(
      Effect.orElseSucceed(() => undefined),
    );
    const pluginSnapshot = yield* integrations.snapshot;
    const docs = yield* documentation.search(question, recentDocumentationContext);
    // This is cached discovery only. Do not refresh providers or authenticate during a snapshot.
    const discovered = yield* providers.getProviders;
    const trace = yield* diagnostics.read({
      traceFilePath: config.serverTracePath,
      maxFiles: Math.max(1, Math.min(config.traceMaxFiles, 3)),
    });
    const modelProvider = discovered.find(
      (provider) => provider.instanceId === modelSelection.instanceId,
    );
    return {
      capturedAt: DateTime.formatIso(yield* DateTime.now),
      environmentId: descriptor.environmentId,
      environmentName: safeText(descriptor.label, 200),
      version: safeText(descriptor.serverVersion, 100),
      platform: `${descriptor.platform.os}/${descriptor.platform.arch}`,
      mode: safeText(config.mode, 100),
      paths: [
        { label: "Host app data", path: config.stateDir },
        { label: "Host settings file", path: config.settingsPath },
        { label: "Host logs", path: config.logsDir },
        { label: "Host worktrees", path: config.worktreesDir },
      ].map(({ label, path }) => ({ label, path: safeText(path, 2_000) })),
      providers: discovered.slice(0, 100).map((provider) => ({
        id: safeText(provider.instanceId, 200),
        name: safeText(provider.displayName ?? provider.instanceId, 200),
        driver: safeText(provider.driver, 100),
        enabled: provider.enabled,
        status: provider.status,
        authenticated:
          provider.auth.status === "unknown" ? null : provider.auth.status === "authenticated",
      })),
      modelLabel: safeText(
        `${modelProvider?.displayName ?? modelSelection.instanceId} / ${modelSelection.model}`,
        300,
      ),
      knowledge: {
        settings: helpSettingsSnapshot(settings, configured, question),
        ...(pluginSnapshot
          ? buildHelpPluginSnapshot(pluginSnapshot, question)
          : { pluginsStatus: "unavailable" as const, plugins: [], pluginsOmittedCount: 0 }),
        ...docs,
      },
      ...(client === undefined ? {} : { client: sanitizeHelpClient(client) }),
      diagnostics: {
        recordCount: trace.recordCount,
        failureCount: trace.failureCount,
        slowSpanCount: trace.slowSpanCount,
        partial:
          trace.recordCount === 0 ||
          trace.parseErrorCount > 0 ||
          Option.getOrElse(trace.partialFailure, () => false) ||
          Option.isSome(trace.error),
        recentFailures: trace.latestFailures.slice(0, 5).map((failure) => ({
          operation: operationName(failure.name),
          category: failureCategory(failure.cause),
          occurredAt: DateTime.formatIso(failure.endedAt),
        })),
      },
    };
  });

  const getContext = readSettings.pipe(
    Effect.flatMap((settings) => contextFor(settings)),
    Effect.catchDefect(() => Effect.fail(new HelpError({ code: "unavailable" }))),
  );

  const ask = Effect.fn("Help.ask")(function* (input: HelpAskInput) {
    // Also validate service callers; not every future transport will be the typed WS endpoint.
    const decoded = yield* decodeHelpInput(input).pipe(
      Effect.mapError(() => new HelpError({ code: "invalid_request" })),
    );
    if (
      decoded.messages.at(-1)?.role !== "user" ||
      decoded.messages.at(-1)?.content.trim() === ""
    ) {
      return yield* new HelpError({ code: "invalid_request" });
    }
    const run = Effect.gen(function* () {
      const settings = yield* readSettings;
      const modelSelection = settings.textGenerationModelSelection;
      const instance = yield* instances.getInstance(modelSelection.instanceId);
      if (!instance?.enabled) return yield* new HelpError({ code: "unavailable" });
      const generateHelp = textGeneration.generateHelp;
      if (!instance.textGeneration.generateHelp || !generateHelp)
        return yield* new HelpError({ code: "unsupported" });
      const messages = decoded.messages.map((message) => ({
        role: message.role,
        content: redact(message.content).slice(0, 8_000),
      }));
      // Only the two preceding supplied Help messages inform follow-up retrieval.
      // Never search other conversations, workspace contents, logs, or client payloads.
      // Put the newest topic first so the retrieval term cap cannot favor older filler.
      const recentDocumentationContext = messages
        .slice(0, -1)
        .slice(-2)
        .toReversed()
        .map((message) => message.content.slice(0, 1_000))
        .join("\n");
      const context = yield* contextFor(
        settings,
        messages.at(-1)!.content,
        decoded.client,
        recentDocumentationContext,
      );
      // An ephemeral empty directory never contains a repo, live state, logs or prior Help runs.
      return yield* Effect.scoped(
        Effect.gen(function* () {
          const cwd = yield* fileSystem
            .makeTempDirectoryScoped({ prefix: "tritonai-help-" })
            .pipe(Effect.mapError(() => new HelpError({ code: "unavailable" })));
          const generated = yield* generateHelp({
            cwd,
            modelSelection,
            messages,
            context,
          }).pipe(Effect.mapError(() => new HelpError({ code: "generation_failed" })));
          const answer = redact(generated.answer).trim().slice(0, 16_000);
          if (!answer) return yield* new HelpError({ code: "generation_failed" });
          return { answer, context } satisfies HelpAskResult;
        }),
      );
    }).pipe(
      Effect.catchDefect(() => Effect.fail(new HelpError({ code: "generation_failed" }))),
      Effect.timeoutOrElse({
        duration: "60 seconds",
        orElse: () => Effect.fail(new HelpError({ code: "timeout" })),
      }),
      budget.withPermitsIfAvailable(1),
    );
    const result = yield* run;
    return Option.isSome(result) ? result.value : yield* new HelpError({ code: "busy" });
  });

  return Help.of({ getContext, ask });
});

export const layer = Layer.effect(Help, make);
