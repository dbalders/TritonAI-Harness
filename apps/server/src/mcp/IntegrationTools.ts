import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import { McpSchema } from "effect/ai";

import * as Integrations from "../integrations/IntegrationRegistry.ts";
import { ExternalToolResultError } from "../integrations/ExternalContent.ts";
import type { IntegrationProviderTool } from "../integrations/IntegrationRegistry.ts";
import { integrationToolJsonSchema } from "../integrations/IntegrationTool.ts";
import {
  describeIntegrationToolFailure,
  IntegrationToolUnavailableError,
} from "../integrations/IntegrationToolFailure.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpToolAccess from "./McpToolAccess.ts";

class IntegrationToolInvocationError extends Schema.TaggedError<IntegrationToolInvocationError>()(
  "IntegrationToolInvocationError",
  { cause: Schema.Defect() },
) {}

export class IntegrationToolRegistrationError extends Schema.TaggedError<IntegrationToolRegistrationError>()(
  "IntegrationToolRegistrationError",
  { toolName: Schema.String },
) {
  override get message(): string {
    return `Integration tool ${this.toolName} conflicts with an existing MCP tool name.`;
  }
}

const INTEGRATION_INVOCATION_CAPABILITY = "integrations.invoke" as const;

export function integrationToolInvocationContext(
  definition: IntegrationProviderTool,
  signal: AbortSignal,
  owner?: McpInvocationContext.McpThreadCaller,
): Integrations.IntegrationInvocationContext {
  return {
    signal,
    ...(definition.readOnly || owner === undefined ? {} : { approvalOwner: owner }),
  };
}

const invocationCanUseIntegrations = (): boolean => {
  const fiber = Fiber.getCurrent();
  if (!fiber) return false;
  return (
    Context.getOrUndefined(
      fiber.context,
      McpInvocationContext.McpInvocationContext,
    )?.capabilities.has(INTEGRATION_INVOCATION_CAPABILITY) === true
  );
};

/** Runtime JSON schemas come from the plugin SDK; access declarations remain host-owned. */
export function toolRegistration(
  definition: IntegrationProviderTool,
  isAvailable: (name: string) => boolean,
) {
  const registration = {
    tool: new McpSchema.Tool({
      name: definition.name,
      description: definition.description,
      inputSchema: integrationToolJsonSchema(definition),
      annotations: {
        title: definition.name,
        readOnlyHint: definition.readOnly,
        destructiveHint: definition.destructive ?? !definition.readOnly,
        idempotentHint: definition.idempotent ?? definition.readOnly,
        openWorldHint: definition.openWorld,
      },
    }),
    annotations: Context.make(
      McpSchema.EnabledWhen,
      () => invocationCanUseIntegrations() && isAvailable(definition.name),
    ),
    handle: (payload: unknown) =>
      Effect.withFiber((fiber) => {
        const invocation = Context.getUnsafe(
          fiber.context,
          McpInvocationContext.McpInvocationContext,
        );
        return invocation.capabilities.has(INTEGRATION_INVOCATION_CAPABILITY) &&
          isAvailable(definition.name)
          ? Effect.tryPromise({
              try: (signal) =>
                Integrations.getIntegrationRegistry().invokeToolForAgent(
                  definition.name,
                  payload,
                  {
                    ownerId: invocation.thread
                      ? `thread:${invocation.thread.threadId}`
                      : `mcp-client:${invocation.client?.sessionId ?? "unbound"}`,
                    providerSessionId:
                      invocation.thread?.providerSessionId ??
                      invocation.client?.sessionId ??
                      "unbound",
                    providerInstanceId:
                      invocation.thread?.providerInstanceId ?? "external-mcp-client",
                  },
                  integrationToolInvocationContext(definition, signal, invocation.thread),
                ),
              catch: (cause) => new IntegrationToolInvocationError({ cause }),
            })
          : Effect.fail(
              new IntegrationToolInvocationError({
                cause: new IntegrationToolUnavailableError("Integration tool is unavailable."),
              }),
            );
      }).pipe(
        Effect.map(
          (value) =>
            new McpSchema.CallToolResult({
              isError: false,
              structuredContent: value,
              content: [{ type: "text", text: JSON.stringify(value) }],
            }),
        ),
        Effect.catchCause((cause) =>
          Effect.logWarning("integration tool invocation failed", {
            toolName: definition.name,
          }).pipe(Effect.andThen(Effect.failCause(cause))),
        ),
        Effect.catch((error) => {
          if (error.cause instanceof ExternalToolResultError)
            return Effect.succeed(
              new McpSchema.CallToolResult({
                isError: true,
                structuredContent: error.cause.result,
                content: [{ type: "text", text: JSON.stringify(error.cause.result) }],
              }),
            );
          const failure = describeIntegrationToolFailure(error.cause);
          return Effect.succeed(
            new McpSchema.CallToolResult({
              isError: true,
              structuredContent: { error: failure.code },
              content: [{ type: "text", text: failure.text }],
            }),
          );
        }),
      ),
  };
  return {
    tool: registration.tool,
    annotations: registration.annotations,
    handler: definition.readOnly
      ? McpToolAccess.reads(registration.handle)
      : McpToolAccess.writesWithCapability((payload: unknown) =>
          McpInvocationContext.McpInvocationContext.pipe(
            Effect.flatMap((scope) =>
              scope.thread !== undefined
                ? registration.handle(payload)
                : Effect.fail(
                    new OrchestratorMcpFailure({
                      code: "capability_denied",
                      message:
                        "Plugin calls require a verified integration-only session with per-call write approval.",
                    }),
                  ),
            ),
          ),
        ),
  };
}

// Bearer identity does not attest the caller's native tool ceiling. Until MCP has
// that boundary, plugin results only travel over the verified private Codex IPC channel.
export const activeToolAvailable = (_name: string) => false;
