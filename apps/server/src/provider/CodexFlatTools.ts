import type { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";

import * as Integrations from "../integrations/IntegrationRegistry.ts";
import { integrationToolJsonSchema } from "../integrations/IntegrationTool.ts";
import { IntegrationToolUnavailableError } from "../integrations/IntegrationToolFailure.ts";
import * as PreviewAutomationBroker from "../mcp/PreviewAutomationBroker.ts";
import {
  invokeTritonAiCommonsTool,
  tritonAiCommonsDynamicToolDefinition,
  TRITONAI_COMMONS_SUBMIT_TOOL_NAME,
} from "../mcp/TritonAiCommonsTool.ts";
import * as ServerConfig from "../config.ts";
import {
  getCodexPreviewDynamicToolDefinitions,
  invokeCodexPreviewDynamicTool,
  isCodexPreviewDynamicTool,
} from "./CodexPreviewDynamicTools.ts";
import {
  computeDynamicToolFingerprint,
  type CodexDynamicToolAvailability,
  type CodexDynamicToolOptions,
} from "./CodexDynamicTools.ts";
import { makePluginToolBrowser, PLUGIN_TOOL_DISCOVERY_NAME } from "./CodexPluginToolDiscovery.ts";

class CodexFlatToolSetupError extends Schema.TaggedError<CodexFlatToolSetupError>()(
  "CodexFlatToolSetupError",
  { detail: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}

// Codex 0.161 rejects a whole thread whose dynamic tools use one of these namespaces (its
// app-server `validate_dynamic_tools`), so tools that would land in one stay direct.
const RESERVED_NAMESPACES = new Set([
  "api_tool",
  "browser",
  "computer",
  "container",
  "file_search",
  "functions",
  "image_gen",
  "mcp",
  "multi_agent_v1",
  "multi_tool_use",
  "python",
  "python_user_visible",
  "submodel_delegator",
  "terminal",
  "tool_search",
  "web",
]);

/**
 * Groups a plugin tool under its plugin (the canonical name's first segment, such as "n8n") so
 * Codex can defer it and find it with tool search. Tool names stay unchanged.
 */
export function deferredPluginTool(
  canonicalName: string,
  defer: boolean,
): { readonly namespace: string; readonly deferLoading: true } | Record<string, never> {
  if (!defer) return {};
  const namespace = canonicalName.split(".")[0]?.replace(/[^a-zA-Z0-9_-]/gu, "_") ?? "";
  if (
    !/^[a-zA-Z0-9_-]{1,64}$/u.test(namespace) ||
    RESERVED_NAMESPACES.has(namespace) ||
    namespace.startsWith("mcp__")
  )
    return {};
  return { namespace, deferLoading: true };
}

/** A native thread's disclosed catalog; each invocation still checks the live grant. */
export const makeCodexFlatToolCatalog = Effect.fn("makeCodexFlatToolCatalog")(function* (input: {
  readonly threadId: ThreadId;
  readonly instanceId: ProviderInstanceId;
  readonly disclosedToolNames?: ReadonlyArray<string>;
  readonly broker?: PreviewAutomationBroker.PreviewAutomationBroker["Service"];
  /** Defer plugin tools behind Codex tool search; only for models that can search. */
  readonly deferPluginTools?: boolean;
}) {
  const sessions = yield* McpProviderSessions.McpProviderSessions;
  const session = yield* sessions.read(input.threadId);
  const context = yield* Effect.context<
    McpProviderSessions.McpProviderSessions | FileSystem.FileSystem | ServerConfig.ServerConfig
  >();
  const runPromise = Effect.runPromiseWith(context);
  const registry = Integrations.getIntegrationRegistryOptional();
  const integrationAccess = session?.capabilities?.has("integrations.invoke") === true;
  const pluginRuntime =
    registry && integrationAccess
      ? yield* Effect.acquireRelease(
          Effect.tryPromise({
            try: () => registry.prepareSkillRuntime(),
            catch: (cause) =>
              new CodexFlatToolSetupError({ detail: "Could not prepare plugin skills.", cause }),
          }),
          (runtime) =>
            runtime
              ? Effect.tryPromise(() => registry.releaseSkillRuntime(runtime.root)).pipe(
                  Effect.ignore,
                )
              : Effect.void,
        )
      : null;
  const bindings =
    registry && integrationAccess
      ? registry.toolDefinitions().flatMap((definition) => {
          const dynamicName = Integrations.codexDynamicIntegrationToolName(definition.name);
          if (
            input.disclosedToolNames === undefined &&
            !definition.readOnly &&
            !registry.isToolAvailableSync(definition.name)
          )
            return [];
          return [
            {
              canonicalName: definition.name,
              name: dynamicName,
              description: `${definition.description} Integration plugin tool: ${definition.name}.`,
              inputSchema: integrationToolJsonSchema(definition),
              requiresApproval: registry.toolRequiresApprovalSync?.(definition.name) ?? false,
              ...deferredPluginTool(definition.name, input.deferPluginTools === true),
            },
          ];
        })
      : [];
  const preview =
    session?.browserToolsAvailable && input.broker
      ? yield* getCodexPreviewDynamicToolDefinitions
      : [];
  const pluginBrowser =
    input.deferPluginTools && integrationAccess
      ? makePluginToolBrowser(
          bindings.filter(
            (tool) =>
              input.disclosedToolNames === undefined ||
              input.disclosedToolNames.includes(tool.name),
          ),
        )
      : undefined;
  const definitions = [
    ...preview,
    ...(integrationAccess ? [tritonAiCommonsDynamicToolDefinition] : []),
    ...(pluginBrowser ? [pluginBrowser.definition] : []),
    ...bindings,
  ];
  if (new Set(definitions.map((definition) => definition.name)).size !== definitions.length) {
    return yield* new CodexFlatToolSetupError({
      detail: "A plugin tool conflicts with a Harness tool name.",
    });
  }
  const disclosed =
    input.disclosedToolNames === undefined
      ? definitions
      : definitions.filter((definition) => input.disclosedToolNames!.includes(definition.name));
  const byName = new Map(bindings.map((binding) => [binding.name, binding.canonicalName]));
  const activeSession = Effect.gen(function* () {
    const current = yield* sessions.read(input.threadId);
    return current?.providerSessionId === session?.providerSessionId &&
      current !== undefined &&
      (current.expiresAt === undefined || (yield* Clock.currentTimeMillis) < current.expiresAt)
      ? current
      : undefined;
  });
  const unavailable = (detail: string): CodexDynamicToolAvailability => ({
    available: false,
    reason: "session_unavailable",
    detail,
  });
  const availability = (name: string): CodexDynamicToolAvailability => {
    if (
      preview.some((definition) => definition.name === name) ||
      name === TRITONAI_COMMONS_SUBMIT_TOOL_NAME ||
      (pluginBrowser !== undefined && name === PLUGIN_TOOL_DISCOVERY_NAME)
    )
      return { available: true };
    const canonicalName = byName.get(name);
    if (!canonicalName || !registry)
      return {
        available: false,
        reason: "unknown_tool",
        detail: "No included plugin provides this tool.",
      };
    const current = registry.toolAvailabilitySync(canonicalName);
    return current.available
      ? { available: true, canonicalName }
      : { ...current, canonicalName, transient: current.reason === "connection_changing" };
  };
  const options: CodexDynamicToolOptions = {
    threadId: input.threadId,
    dynamicTools: disclosed,
    dynamicToolAvailability: availability,
    awaitDynamicToolAvailability: async (name, { signal }) => {
      if (!(await runPromise(activeSession, { signal })))
        return unavailable("This thread's provider credential is no longer active.");
      const canonicalName = byName.get(name);
      return canonicalName && registry
        ? { ...(await registry.awaitToolAvailability(canonicalName, { signal })), canonicalName }
        : availability(name);
    },
    invokeDynamicTool: async ({ name, arguments: args, signal, writeApproved }) => {
      const current = await runPromise(activeSession, { signal });
      if (!current)
        throw new IntegrationToolUnavailableError(
          "This thread's provider credential is no longer active.",
        );
      if (name === PLUGIN_TOOL_DISCOVERY_NAME && pluginBrowser) {
        if (!current.capabilities?.has("integrations.invoke"))
          throw new IntegrationToolUnavailableError("This provider session cannot use plugins.");
        return pluginBrowser.browse(args);
      }
      if (name === TRITONAI_COMMONS_SUBMIT_TOOL_NAME) {
        if (!current.capabilities?.has("integrations.invoke"))
          throw new IntegrationToolUnavailableError("This provider session cannot use plugins.");
        return invokeTritonAiCommonsTool({
          arguments: args,
          providerInstanceId: input.instanceId,
          signal,
          writeApproved: writeApproved === true,
        });
      }
      if (isCodexPreviewDynamicTool(name) && input.broker && session) {
        return runPromise(
          invokeCodexPreviewDynamicTool({
            name,
            arguments: args,
            sessionIdentity: session,
            broker: input.broker,
          }),
          { signal },
        );
      }
      const canonicalName = byName.get(name);
      if (!canonicalName || !registry || !current.capabilities?.has("integrations.invoke"))
        throw new IntegrationToolUnavailableError(
          "This provider session cannot use that plugin tool.",
        );
      const currentAvailability = await registry.awaitToolAvailability(canonicalName, { signal });
      if (!currentAvailability.available)
        throw new IntegrationToolUnavailableError("The plugin tool is unavailable.", {
          toolName: canonicalName,
          reason: currentAvailability.reason,
          detail: currentAvailability.detail,
        });
      return registry.invokeTool(canonicalName, args, {
        signal,
        ...(writeApproved ? { writeApproved: true } : {}),
      });
    },
  };
  return {
    options,
    activeSession,
    fingerprint: computeDynamicToolFingerprint(disclosed),
    names: disclosed.map((definition) => definition.name),
    skills: pluginRuntime?.skills ?? [],
    registry,
  };
});

export type CodexFlatToolCatalog = Effect.Success<ReturnType<typeof makeCodexFlatToolCatalog>>;
