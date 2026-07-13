import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/unstable/ai";

import { normalizeIntegrationToolResult, registrationLayerFor } from "./IntegrationTools.ts";
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
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  readOnly: true,
  openWorld: false,
} as const;

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
        inputSchema: fixtureTool.inputSchema,
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

it("rejects write-capable tools at the MCP registration boundary", () => {
  expect(() => registrationLayerFor([{ ...fixtureTool, readOnly: false }], () => true)).toThrow(
    /write-capable MCP integration tools are not supported/u,
  );
});

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

it.effect("hides integration tools from MCP credentials without read access", () =>
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

it.effect("shows active integration tools only to read-authorized MCP credentials", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const enabledWhen = Context.getUnsafe(server.tools[0]!.annotations, McpSchema.EnabledWhen);
      const visible = yield* Effect.sync(() => enabledWhen({} as never)).pipe(
        Effect.provideService(
          McpInvocationContext.McpInvocationContext,
          invocation(new Set(["integrations.read"])),
        ),
      );
      expect(visible).toBe(true);
    }).pipe(Effect.provide(testLayer)),
  ),
);
