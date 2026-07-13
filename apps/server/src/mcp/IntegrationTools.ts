import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { McpSchema, McpServer } from "effect/unstable/ai";

import * as Integrations from "../integrations/IntegrationRegistry.ts";
import type { IntegrationProviderTool } from "../integrations/IntegrationRegistry.ts";
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

const invocationCanReadIntegrations = (): boolean => {
  const fiber = Fiber.getCurrent();
  if (!fiber) return false;
  return (
    Context.getOrUndefined(
      fiber.context,
      McpInvocationContext.McpInvocationContext,
    )?.capabilities.has("integrations.read") === true
  );
};

function assertReadOnlyTool(definition: IntegrationProviderTool): void {
  if (!definition.readOnly) {
    throw new Error(
      `Integration tool ${definition.name} is not read-only; write-capable MCP integration tools are not supported.`,
    );
  }
}

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
  assertReadOnlyTool(definition);
  const registration: Parameters<typeof server.addTool>[0] = {
    tool: new McpSchema.Tool({
      name: definition.name,
      description: definition.description,
      inputSchema: definition.inputSchema,
      annotations: {
        title: definition.name,
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: definition.openWorld,
      },
    }),
    annotations: Context.make(
      McpSchema.EnabledWhen,
      () => invocationCanReadIntegrations() && isAvailable(definition.name),
    ),
    handle: (payload) =>
      Effect.withFiber((fiber) => {
        const invocation = Context.getUnsafe(
          fiber.context,
          McpInvocationContext.McpInvocationContext,
        );
        return invocation.capabilities.has("integrations.read")
          ? Effect.tryPromise({
              try: async () =>
                normalizeIntegrationToolResult(
                  await Integrations.getIntegrationRegistry().invokeTool(definition.name, payload),
                ),
              catch: (cause) => new IntegrationToolInvocationError({ cause }),
            })
          : Effect.fail(
              new IntegrationToolInvocationError({
                cause: new Error("MCP credential does not grant read-only integration access."),
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
  for (const definition of definitions) assertReadOnlyTool(definition);
  return Layer.effectDiscard(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      for (const definition of definitions) {
        yield* registerTool(server, definition, isAvailable, reservedToolNames);
      }
    }),
  );
};

export const registrationLayer = (reservedToolNames: ReadonlySet<string> = new Set()) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const context = yield* Effect.context<never>();
      const runFork = Effect.runForkWith(context);
      const registered = new Set<string>();
      const integrationSubscriptions = new Set<() => void>();
      const register = (definition: IntegrationProviderTool) => {
        if (registered.has(definition.name)) return;
        registered.add(definition.name);
        runFork(
          registerTool(server, definition, activeToolAvailable, reservedToolNames).pipe(
            Effect.catchCause((cause) =>
              Effect.logError("integration tool registration failed", {
                toolName: definition.name,
                cause,
              }),
            ),
          ),
        );
      };
      const unsubscribeRegistry = Integrations.observeIntegrationRegistry((registry) => {
        integrationSubscriptions.add(registry.observeToolDefinitions(register));
      });
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          unsubscribeRegistry();
          for (const unsubscribe of integrationSubscriptions) unsubscribe();
        }),
      );
    }),
  );
