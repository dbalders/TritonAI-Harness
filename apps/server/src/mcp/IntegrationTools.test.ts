import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/unstable/ai";

import {
  EmptyIntegrationToolInput,
  integrationToolJsonSchema,
} from "../integrations/IntegrationTool.ts";
import {
  normalizeIntegrationToolResult,
  registrationLayer,
  registrationLayerFor,
} from "./IntegrationTools.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";

const invocation = (
  capabilities: McpInvocationContext.McpInvocationScope["capabilities"],
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-1"),
  providerSessionId: "provider-session-1",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities,
  issuedAt: 1,
  expiresAt: 2,
});

const fixtureTool = {
  name: "fixture.read",
  description: "Read deterministic fixture data.",
  input: EmptyIntegrationToolInput,
  readOnly: true,
  openWorld: false,
} as const;

const writeFixtureTool = {
  ...fixtureTool,
  name: "fixture.write",
  description: "Write deterministic fixture data.",
  readOnly: false,
  destructive: true,
  idempotent: false,
} as const;

const registryWith = (definitions: ReadonlyArray<typeof fixtureTool>) => ({
  toolDefinitions: () => definitions,
});

const testLayer = registrationLayerFor([fixtureTool], () => true).pipe(
  Layer.provideMerge(McpServer.McpServer.layer),
);

const serverWithBuiltInFixture = Layer.effect(
  McpServer.McpServer,
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    yield* server.addTool({
      tool: new McpSchema.Tool({
        name: fixtureTool.name,
        description: "Existing built-in fixture tool.",
        inputSchema: integrationToolJsonSchema(fixtureTool),
      }),
      annotations: Context.empty(),
      handle: () =>
        Effect.succeed(
          new McpSchema.CallToolResult({
            isError: false,
            structuredContent: { source: "built-in" },
            content: [{ type: "text", text: "built-in" }],
          }),
        ),
    });
    return server;
  }),
).pipe(Layer.provide(McpServer.McpServer.layer));

it.effect("registers provider-neutral tool definitions with MCP", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      expect(server.tools.map(({ tool }) => tool.name)).toEqual(["fixture.read"]);
      expect(server.tools[0]?.tool.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      });
    }).pipe(Effect.provide(testLayer)),
  ),
);

it.effect("awaits the canonical registry catalog before the MCP layer becomes available", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      expect(server.tools.map(({ tool }) => tool.name)).toEqual([fixtureTool.name]);
    }).pipe(
      Effect.provide(
        registrationLayer(new Set(), async () => registryWith([fixtureTool])).pipe(
          Layer.provideMerge(McpServer.McpServer.layer),
        ),
      ),
    ),
  ),
);

it.effect("fails MCP startup when a catalog tool is reserved", () =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(
      Effect.void.pipe(
        Effect.provide(
          registrationLayer(new Set([fixtureTool.name]), async () =>
            registryWith([fixtureTool]),
          ).pipe(Layer.provideMerge(McpServer.McpServer.layer)),
        ),
      ),
    );
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      expect(Cause.pretty(exit.cause)).toContain(
        "Integration tool fixture.read conflicts with an existing MCP tool name.",
      );
    }
  }).pipe(Effect.scoped),
);

it.effect("registers write-capable tools with conservative MCP annotations", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      expect(server.tools[0]?.tool.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
      });
    }).pipe(
      Effect.provide(
        registrationLayerFor([writeFixtureTool], () => true).pipe(
          Layer.provideMerge(McpServer.McpServer.layer),
        ),
      ),
    ),
  ),
);

it.effect("rejects integration tool names that collide with existing MCP tools", () =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(
      Effect.void.pipe(
        Effect.provide(
          registrationLayerFor([fixtureTool], () => true).pipe(
            Layer.provideMerge(serverWithBuiltInFixture),
          ),
        ),
      ),
    );
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      expect(Cause.pretty(exit.cause)).toContain(
        "Integration tool fixture.read conflicts with an existing MCP tool name.",
      );
    }
  }).pipe(Effect.scoped),
);

it.effect("rejects reserved built-in names before built-in registration completes", () =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(
      Effect.void.pipe(
        Effect.provide(
          registrationLayerFor([fixtureTool], () => true, new Set([fixtureTool.name])).pipe(
            Layer.provideMerge(McpServer.McpServer.layer),
          ),
        ),
      ),
    );
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      expect(Cause.pretty(exit.cause)).toContain(
        "Integration tool fixture.read conflicts with an existing MCP tool name.",
      );
    }
  }).pipe(Effect.scoped),
);

it("normalizes arbitrary provider results into JSON object content", () => {
  expect(normalizeIntegrationToolResult("ready")).toEqual({ result: "ready" });
  expect(normalizeIntegrationToolResult([1, 2])).toEqual({ result: [1, 2] });
  expect(normalizeIntegrationToolResult(undefined)).toEqual({ result: null });
  expect(normalizeIntegrationToolResult({ value: 1, omitted: undefined })).toEqual({ value: 1 });
  expect(() => normalizeIntegrationToolResult(1n)).toThrow(/JSON-serializable/u);
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  expect(() => normalizeIntegrationToolResult(cyclic)).toThrow(/JSON-serializable/u);
});

it.effect("hides integration tools from MCP credentials without integration access", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const enabledWhen = Context.getUnsafe(server.tools[0]!.annotations, McpSchema.EnabledWhen);
      const visible = yield* Effect.sync(() => enabledWhen({} as never)).pipe(
        Effect.provideService(
          McpInvocationContext.McpInvocationContext,
          invocation(new Set(["preview"])),
        ),
      );
      expect(visible).toBe(false);
      const result = yield* server
        .callTool({ name: "fixture.read", arguments: {} })
        .pipe(
          Effect.provideService(
            McpInvocationContext.McpInvocationContext,
            invocation(new Set(["preview"])),
          ),
          Effect.provideService(McpSchema.McpServerClient, {} as never),
        );
      expect(result).toMatchObject({
        isError: true,
        structuredContent: { error: "integration_tool_unavailable" },
      });
    }).pipe(Effect.provide(testLayer)),
  ),
);

it.effect("shows active integration tools to integration-authorized MCP credentials", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const enabledWhen = Context.getUnsafe(server.tools[0]!.annotations, McpSchema.EnabledWhen);
      const visible = yield* Effect.sync(() => enabledWhen({} as never)).pipe(
        Effect.provideService(
          McpInvocationContext.McpInvocationContext,
          invocation(new Set(["integrations.invoke"])),
        ),
      );
      expect(visible).toBe(true);
    }).pipe(Effect.provide(testLayer)),
  ),
);

it.effect("uses the same transport grant for active read and write integration tools", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const enabledWhen = Context.getUnsafe(server.tools[0]!.annotations, McpSchema.EnabledWhen);
      const previewVisible = yield* Effect.sync(() => enabledWhen({} as never)).pipe(
        Effect.provideService(
          McpInvocationContext.McpInvocationContext,
          invocation(new Set(["preview"])),
        ),
      );
      const integrationVisible = yield* Effect.sync(() => enabledWhen({} as never)).pipe(
        Effect.provideService(
          McpInvocationContext.McpInvocationContext,
          invocation(new Set(["integrations.invoke"])),
        ),
      );
      expect(previewVisible).toBe(false);
      expect(integrationVisible).toBe(true);
    }).pipe(
      Effect.provide(
        registrationLayerFor([writeFixtureTool], () => true).pipe(
          Layer.provideMerge(McpServer.McpServer.layer),
        ),
      ),
    ),
  ),
);

it.effect("hides and rejects an unavailable tool despite read authorization", () => {
  let availabilityChecks = 0;
  const unavailable = () => {
    availabilityChecks += 1;
    return false;
  };
  return Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const enabledWhen = Context.getUnsafe(server.tools[0]!.annotations, McpSchema.EnabledWhen);
      const authorized = invocation(new Set(["integrations.invoke"]));
      const visible = yield* Effect.sync(() => enabledWhen({} as never)).pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, authorized),
      );
      expect(visible).toBe(false);
      const result = yield* server
        .callTool({ name: "fixture.read", arguments: {} })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, authorized),
          Effect.provideService(McpSchema.McpServerClient, {} as never),
        );
      expect(result).toMatchObject({
        isError: true,
        structuredContent: { error: "integration_tool_unavailable" },
      });
      expect(availabilityChecks).toBe(2);
    }).pipe(
      Effect.provide(
        registrationLayerFor([fixtureTool], unavailable).pipe(
          Layer.provideMerge(McpServer.McpServer.layer),
        ),
      ),
    ),
  );
});
