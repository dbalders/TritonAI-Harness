import { PreviewAutomationSnapshot, PreviewAutomationUnavailableError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { Tool } from "effect/unstable/ai";

import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import * as PreviewAutomationBroker from "../../mcp/PreviewAutomationBroker.ts";
import { PreviewToolkitHandlersLive } from "../../mcp/toolkits/preview/handlers.ts";
import { PreviewToolkit } from "../../mcp/toolkits/preview/tools.ts";

export interface CodexPreviewDynamicToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly requiresApproval: boolean;
}

export class CodexPreviewDynamicToolNotFoundError extends Schema.TaggedErrorClass<CodexPreviewDynamicToolNotFoundError>()(
  "CodexPreviewDynamicToolNotFoundError",
  { toolName: Schema.String },
) {
  override get message(): string {
    return `Unknown preview tool: ${this.toolName}`;
  }
}

export class CodexPreviewDynamicToolInvocationError extends Schema.TaggedErrorClass<CodexPreviewDynamicToolInvocationError>()(
  "CodexPreviewDynamicToolInvocationError",
  { toolName: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Preview tool ${this.toolName} invocation failed.`;
  }
}

const isInvocationError = Schema.is(CodexPreviewDynamicToolInvocationError);

export function makeCodexPreviewDynamicToolFailureResult(cause: unknown): {
  readonly success: false;
  readonly error: { readonly type: string; readonly message: string };
} {
  const underlying = isInvocationError(cause) ? cause.cause : cause;
  const type =
    typeof underlying === "object" &&
    underlying !== null &&
    "_tag" in underlying &&
    typeof underlying._tag === "string"
      ? underlying._tag
      : underlying instanceof Error
        ? underlying.name
        : "PreviewToolError";
  const message =
    underlying instanceof Error
      ? underlying.message
      : typeof underlying === "string"
        ? underlying
        : "The collaborative browser request failed.";
  return { success: false, error: { type, message } };
}

const codexWebResearchToolNames = new Set([
  "preview_status",
  "preview_open",
  "preview_navigate",
  "preview_snapshot",
  "preview_click",
  "preview_type",
  "preview_press",
  "preview_scroll",
  "preview_evaluate",
  "preview_wait_for",
]);
const previewTools = Object.values(PreviewToolkit.tools).filter((tool) =>
  codexWebResearchToolNames.has(tool.name),
);

export const codexPreviewDynamicToolDefinitions: ReadonlyArray<CodexPreviewDynamicToolDefinition> =
  previewTools.map((tool) => ({
    name: tool.name,
    description:
      tool.name === "preview_snapshot"
        ? "Read the current page's text, semantic elements, accessibility tree, diagnostics, and action history. Screenshot image bytes are omitted."
        : (Tool.getDescription(tool) ?? `Use the ${tool.name} collaborative browser tool.`),
    inputSchema: Tool.getJsonSchema(tool) as Readonly<Record<string, unknown>>,
    requiresApproval: Context.get(tool.annotations, Tool.Destructive),
  }));

const previewToolNames = new Set(codexPreviewDynamicToolDefinitions.map(({ name }) => name));
const isPreviewAutomationSnapshot = Schema.is(PreviewAutomationSnapshot);

export function isCodexPreviewDynamicTool(name: string): boolean {
  return previewToolNames.has(name);
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

export const invokeAuthorizedCodexPreviewDynamicTool = Effect.fn(
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

  if (!input.invocationScope.capabilities.has("preview")) {
    return yield* new PreviewAutomationUnavailableError({
      capability: "preview",
      environmentId: input.invocationScope.environmentId,
      threadId: input.invocationScope.threadId,
      providerSessionId: input.invocationScope.providerSessionId,
      providerInstanceId: input.invocationScope.providerInstanceId,
    });
  }

  const handled = yield* Effect.gen(function* () {
    const toolkit = yield* PreviewToolkit;
    const resultStream = yield* toolkit.handle(
      input.name as keyof typeof PreviewToolkit.tools,
      input.arguments as never,
    );
    return yield* resultStream.pipe(Stream.run(Sink.last()), Effect.flatMap(Effect.fromOption));
  }).pipe(
    Effect.provide(PreviewToolkitHandlersLive),
    Effect.provideService(PreviewAutomationBroker.PreviewAutomationBroker, input.broker),
    Effect.provideService(McpInvocationContext.McpInvocationContext, input.invocationScope),
    Effect.mapError(
      (cause) => new CodexPreviewDynamicToolInvocationError({ toolName: input.name, cause }),
    ),
  );

  if (handled.isFailure) {
    return yield* new CodexPreviewDynamicToolInvocationError({
      toolName: input.name,
      cause: handled.result,
    });
  }
  return sanitizePreviewToolResult(handled.encodedResult);
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
    const mcpSession = McpProviderSession.readMcpProviderSession(input.sessionIdentity.threadId);
    if (
      !mcpSession ||
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
      threadId: mcpSession.threadId,
      providerSessionId: mcpSession.providerSessionId,
      providerInstanceId: mcpSession.providerInstanceId,
      capabilities: new Set(["preview"]),
      issuedAt: 0,
      expiresAt: Number.MAX_SAFE_INTEGER,
    };

    return yield* invokeAuthorizedCodexPreviewDynamicTool({
      name: input.name,
      arguments: input.arguments,
      invocationScope,
      broker: input.broker,
    });
  },
);
