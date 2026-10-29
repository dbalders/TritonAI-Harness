import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import { McpSchema } from "effect/ai";

import * as Integrations from "../integrations/IntegrationRegistry.ts";
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

function integrationToolInvocationContext(
  definition: IntegrationProviderTool,
  signal: AbortSignal,
): Integrations.IntegrationInvocationContext {
  return {
    signal,
    // Harness gives this bearer only to its managed provider runtime, which enforces
    // the selected task mode before issuing an MCP write call. Mark that trusted
    // adapter boundary explicitly so Registry retains its write gate without adding
    // a second, contradictory approval layer.
    ...(definition.readOnly ? {} : { writeApproved: true }),
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
                Integrations.getIntegrationRegistry().invokeTool(
                  definition.name,
                  payload,
                  integrationToolInvocationContext(definition, signal),
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
              scope.thread !== undefined || scope.client?.access === "full-access"
                ? registration.handle(payload)
                : Effect.fail(
                    new OrchestratorMcpFailure({
                      code: "capability_denied",
                      message:
                        "Plugin writes require a full-access outside MCP client or approval through a T3-launched provider.",
                    }),
                  ),
            ),
          ),
        ),
  };
}

export const activeToolAvailable = (name: string) =>
  Boolean(Integrations.getIntegrationRegistryOptional()?.isToolAvailableSync(name));
