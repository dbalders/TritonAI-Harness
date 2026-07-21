import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { McpSchema, McpServer } from "effect/unstable/ai";

import * as Integrations from "../integrations/IntegrationRegistry.ts";
import type { IntegrationProviderTool } from "../integrations/IntegrationRegistry.ts";
import { integrationToolJsonSchema } from "../integrations/IntegrationTool.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";

class IntegrationToolInvocationError extends Schema.TaggedErrorClass<IntegrationToolInvocationError>()(
  "IntegrationToolInvocationError",
  { cause: Schema.Defect() },
) {}

class IntegrationToolRegistrationError extends Schema.TaggedErrorClass<IntegrationToolRegistrationError>()(
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
): Integrations.IntegrationInvocationContext {
  return {
    signal,
    // MCP clients enforce the selected task runtime mode before issuing a write call.
    // Mark the authenticated provider call as approved so Registry can retain its
    // explicit write gate without adding a second, contradictory approval layer.
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

export function normalizeIntegrationToolResult(value: unknown): Record<string, unknown> {
  if (typeof value === "bigint" || typeof value === "function" || typeof value === "symbol") {
    throw new Error("Integration tool results must be JSON-serializable.");
  }
  const candidate =
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? value
      : { result: value ?? null };
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(candidate);
  } catch (error) {
    throw new Error("Integration tool results must be JSON-serializable.", { cause: error });
  }
  if (!serialized) throw new Error("Integration tool results must be JSON-serializable.");
  const parsed: unknown = JSON.parse(serialized);
  if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>;
  }
  return { result: parsed };
}

function registerTool(
  server: McpServer.McpServer["Service"],
  definition: IntegrationProviderTool,
  isAvailable: (name: string) => boolean,
  reservedToolNames: ReadonlySet<string>,
) {
  const registration: Parameters<typeof server.addTool>[0] = {
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
    handle: (payload) =>
      Effect.withFiber((fiber) => {
        const invocation = Context.getUnsafe(
          fiber.context,
          McpInvocationContext.McpInvocationContext,
        );
        return invocation.capabilities.has(INTEGRATION_INVOCATION_CAPABILITY) &&
          isAvailable(definition.name)
          ? Effect.tryPromise({
              try: async (signal) =>
                normalizeIntegrationToolResult(
                  await Integrations.getIntegrationRegistry().invokeTool(
                    definition.name,
                    payload,
                    integrationToolInvocationContext(definition, signal),
                  ),
                ),
              catch: (cause) => new IntegrationToolInvocationError({ cause }),
            })
          : Effect.fail(
              new IntegrationToolInvocationError({
                cause: new Error("MCP credential does not grant integration invocation access."),
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
        Effect.orElseSucceed(
          () =>
            new McpSchema.CallToolResult({
              isError: true,
              structuredContent: { error: "integration_tool_unavailable" },
              content: [{ type: "text", text: "Integration tool is unavailable." }],
            }),
        ),
      ),
  };
  return Effect.suspend(() => {
    if (
      reservedToolNames.has(definition.name) ||
      server.tools.some(({ tool }) => tool.name === definition.name)
    ) {
      return Effect.fail(new IntegrationToolRegistrationError({ toolName: definition.name }));
    }
    return server.addTool(registration);
  });
}

const activeToolAvailable = (name: string) =>
  Boolean(Integrations.getIntegrationRegistryOptional()?.isToolAvailableSync(name));

export const registrationLayerFor = (
  definitions: ReadonlyArray<IntegrationProviderTool>,
  isAvailable: (name: string) => boolean = activeToolAvailable,
  reservedToolNames: ReadonlySet<string> = new Set(),
) => {
  return Layer.effectDiscard(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      for (const definition of definitions) {
        yield* registerTool(server, definition, isAvailable, reservedToolNames);
      }
    }),
  );
};

export const registrationLayer = (
  reservedToolNames: ReadonlySet<string> = new Set(),
  loadRegistry: () => Promise<
    Pick<Integrations.RegistryRuntime, "toolDefinitions">
  > = Integrations.awaitIntegrationRegistry,
) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const registry = yield* Effect.promise(loadRegistry);
      for (const definition of registry.toolDefinitions()) {
        yield* registerTool(server, definition, activeToolAvailable, reservedToolNames);
      }
    }),
  );
