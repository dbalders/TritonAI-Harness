import * as Clock from "effect/Clock";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import {
  PreviewAutomationSnapshot,
  PreviewAutomationActInputs,
  PreviewAutomationUnavailableError,
  type PreviewAutomationOperation,
  type PreviewTabId,
  type PreviewAutomationOpenInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Tool } from "effect/ai";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as McpProviderSession from "@t3tools/provider-core/server/mcpSession";
import * as PreviewAutomationBroker from "../mcp/PreviewAutomationBroker.ts";
import { withBrowserNavigationOutcome } from "../preview/BrowserNavigationApproval.ts";

export interface CodexPreviewDynamicToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly requiresApproval: boolean;
}

class CodexPreviewDynamicToolNotFoundError extends Schema.TaggedError<CodexPreviewDynamicToolNotFoundError>()(
  "CodexPreviewDynamicToolNotFoundError",
  { toolName: Schema.String },
) {
  override get message(): string {
    return `Unknown preview tool: ${this.toolName}`;
  }
}

class CodexPreviewDynamicToolInvocationError extends Schema.TaggedError<CodexPreviewDynamicToolInvocationError>()(
  "CodexPreviewDynamicToolInvocationError",
  { toolName: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Preview tool ${this.toolName} invocation failed.`;
  }
}

const codexWebResearchToolNames = new Set([
  "preview_status",
  "preview_open",
  "preview_navigate",
  "preview_snapshot",
  "preview_act",
  "preview_evaluate",
  "preview_wait_for",
]);
// Provider discovery must not initialize the orchestration facade through the
// MCP handler graph. Resolve the shared toolkit once a live session asks for it.
const readPreviewTools = async () => {
  const { PreviewToolkit } = await import("../mcp/toolkits/preview/tools.ts");
  return Object.values(PreviewToolkit.tools)
    .filter((tool) => codexWebResearchToolNames.has(tool.name))
    .map((tool) => ({
      ...tool,
      decodeParameters: Schema.decodeUnknownEffect(tool.parametersSchema),
    }));
};
let previewToolsPromise: ReturnType<typeof readPreviewTools> | undefined;
const loadPreviewTools = Effect.promise(() => (previewToolsPromise ??= readPreviewTools()));

export const getCodexPreviewDynamicToolDefinitions = loadPreviewTools.pipe(
  Effect.map((tools): ReadonlyArray<CodexPreviewDynamicToolDefinition> =>
    tools.map((tool) => ({
      name: tool.name,
      description:
        tool.name === "preview_snapshot"
          ? "Read the current page's text, semantic elements, accessibility tree, diagnostics, and action history. Screenshot image bytes are omitted."
          : (Tool.getDescription(tool) ?? `Use the ${tool.name} collaborative browser tool.`),
      inputSchema: Tool.getJsonSchema(tool) as Readonly<Record<string, unknown>>,
      requiresApproval: Context.get(tool.annotations, Tool.Destructive),
    })),
  ),
);

const isPreviewAutomationSnapshot = Schema.is(PreviewAutomationSnapshot);

export function isCodexPreviewDynamicTool(name: string): boolean {
  return codexWebResearchToolNames.has(name);
}

// Browser screenshots are intentionally not returned through the model transport.
// The snapshot's DOM text, accessibility tree, and interactive elements provide
// the research context without requiring a second image-capable model.
function sanitizePreviewToolResult(encodedResult: unknown): unknown {
  if (!isPreviewAutomationSnapshot(encodedResult)) return encodedResult;
  const { screenshot, ...page } = encodedResult;
  return {
    ...page,
    screenshot: {
      mimeType: screenshot.mimeType,
      width: screenshot.width,
      height: screenshot.height,
      omitted: true,
    },
  };
}

const invokeAuthorizedCodexPreviewDynamicTool = Effect.fn(
  "invokeAuthorizedCodexPreviewDynamicTool",
)(function* (input: {
  readonly name: string;
  readonly arguments: unknown;
  readonly invocationScope: McpInvocationContext.McpInvocationScope;
  readonly broker: PreviewAutomationBroker.PreviewAutomationBroker["Service"];
}) {
  if (!isCodexPreviewDynamicTool(input.name)) {
    return yield* new CodexPreviewDynamicToolNotFoundError({ toolName: input.name });
  }

  if (!input.invocationScope.capabilities.has("preview") || !input.invocationScope.thread) {
    return yield* new PreviewAutomationUnavailableError({
      capability: "preview",
      environmentId: input.invocationScope.environmentId,
      threadId: input.invocationScope.thread?.threadId,
      providerSessionId: input.invocationScope.thread?.providerSessionId,
      providerInstanceId: input.invocationScope.thread?.providerInstanceId,
    });
  }

  const tool = (yield* loadPreviewTools).find((tool) => tool.name === input.name)!;
  const parameters = yield* tool.decodeParameters(input.arguments);
  let actionOperation: PreviewAutomationOperation | undefined;
  let operationParameters: unknown = parameters;
  if (input.name === "preview_act") {
    const act = parameters as { action: keyof typeof PreviewAutomationActInputs };
    const { action, ...args } = act;
    actionOperation = action;
    operationParameters = yield* decodePreviewActions[action](args);
  }
  const { tabId, timeoutMs, ...args } = operationParameters as {
    tabId?: PreviewTabId;
    timeoutMs?: number;
    readonly [key: string]: unknown;
  };
  const operations: Readonly<Record<string, PreviewAutomationOperation>> = {
    preview_status: "status",
    preview_open: "open",
    preview_navigate: "navigate",
    preview_snapshot: "snapshot",
    preview_evaluate: "evaluate",
    preview_wait_for: "waitFor",
  };
  // The managed adapter checks live turn ownership and write consent before entering
  // this path. Reuse the same broker operation as MCP without introducing a service
  // dependency from the provider adapter back into the orchestration facade.
  const operation = actionOperation ?? operations[input.name]!;
  const { invokePreviewOperation, normalizePreviewOpenInput } = yield* Effect.promise(
    () => import("../mcp/toolkits/preview/handlers.ts"),
  );
  const { result, toolIcon } = yield* invokePreviewOperation<unknown>(
    operation,
    operation === "open" ? normalizePreviewOpenInput(args as PreviewAutomationOpenInput) : args,
    timeoutMs,
    tabId,
  ).pipe(
    Effect.provideService(PreviewAutomationBroker.PreviewAutomationBroker, input.broker),
    Effect.provideService(McpInvocationContext.McpInvocationContext, input.invocationScope),
    Effect.mapError(
      (cause) => new CodexPreviewDynamicToolInvocationError({ toolName: input.name, cause }),
    ),
  );
  const value =
    operation === "evaluate" ? { value: result ?? null } : sanitizePreviewToolResult(result);
  if (value === null || typeof value !== "object") return value;
  const reported = withBrowserNavigationOutcome(input.name, input.arguments, value);
  return { ...reported, ...(toolIcon ? { toolIcon } : {}) };
});

export const invokeCodexPreviewDynamicTool = Effect.fn("invokeCodexPreviewDynamicTool")(
  function* (input: {
    readonly name: string;
    readonly arguments: unknown;
    readonly sessionIdentity: Pick<
      McpProviderSession.McpProviderSessionConfig,
      "environmentId" | "threadId" | "providerSessionId" | "providerInstanceId"
    >;
    readonly broker: PreviewAutomationBroker.PreviewAutomationBroker["Service"];
  }) {
    const mcpSession = yield* (yield* McpProviderSessions.McpProviderSessions).read(
      input.sessionIdentity.threadId,
    );
    if (
      !mcpSession ||
      !mcpSession.browserToolsAvailable ||
      !mcpSession.capabilities?.has("preview") ||
      (mcpSession.expiresAt !== undefined &&
        (yield* Clock.currentTimeMillis) >= mcpSession.expiresAt) ||
      mcpSession.environmentId !== input.sessionIdentity.environmentId ||
      mcpSession.providerSessionId !== input.sessionIdentity.providerSessionId ||
      mcpSession.providerInstanceId !== input.sessionIdentity.providerInstanceId
    ) {
      return yield* new PreviewAutomationUnavailableError({
        capability: "preview",
        environmentId: input.sessionIdentity.environmentId,
        threadId: input.sessionIdentity.threadId,
        providerSessionId: input.sessionIdentity.providerSessionId,
        providerInstanceId: input.sessionIdentity.providerInstanceId,
      });
    }
    const invocationScope: McpInvocationContext.McpInvocationScope = {
      environmentId: mcpSession.environmentId,
      requestNamespace: mcpSession.providerSessionId,
      thread: {
        threadId: mcpSession.threadId,
        providerSessionId: mcpSession.providerSessionId,
        providerInstanceId: mcpSession.providerInstanceId,
      },
      client: undefined,
      capabilities: new Set(
        [...mcpSession.capabilities].filter(
          (capability): capability is "preview" => capability === "preview",
        ),
      ),
      issuedAt: 0,
      expiresAt: mcpSession.expiresAt ?? Number.MAX_SAFE_INTEGER,
    };

    return yield* invokeAuthorizedCodexPreviewDynamicTool({
      name: input.name,
      arguments: input.arguments,
      invocationScope,
      broker: input.broker,
    });
  },
);

const decodePreviewActions = {
  click: Schema.decodeUnknownEffect(PreviewAutomationActInputs.click),
  type: Schema.decodeUnknownEffect(PreviewAutomationActInputs.type),
  hover: Schema.decodeUnknownEffect(PreviewAutomationActInputs.hover),
  select: Schema.decodeUnknownEffect(PreviewAutomationActInputs.select),
  drag: Schema.decodeUnknownEffect(PreviewAutomationActInputs.drag),
  upload: Schema.decodeUnknownEffect(PreviewAutomationActInputs.upload),
  press: Schema.decodeUnknownEffect(PreviewAutomationActInputs.press),
  scroll: Schema.decodeUnknownEffect(PreviewAutomationActInputs.scroll),
};
