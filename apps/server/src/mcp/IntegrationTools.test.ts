import { expect, it, vi } from "@effect/vitest";
import {
  EnvironmentId,
  IntegrationOperationError,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { McpSchema, McpServer, Tool, Toolkit } from "effect/ai";
import { EmptyIntegrationToolInput } from "../integrations/IntegrationTool.ts";
import * as Integrations from "../integrations/IntegrationRegistry.ts";
import {
  integrationToolsRegistrationLayer as registrationLayer,
  integrationToolsRegistrationLayerFor as registrationLayerFor,
  toolkitRegistration,
} from "./McpHttpServer.ts";
import * as McpToolAccess from "./McpToolAccess.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { liveThreadShell, liveThreadsLayer } from "./McpToolAccess.testkit.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  clientCapabilities: {},
  clientInfo: { name: "integration-mcp-test", version: "1.0.0" },
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "integration-mcp-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

const invocation = (
  capabilities: McpInvocationContext.McpInvocationScope["capabilities"],
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment-1"),
  requestNamespace: "provider-session-1",
  client: undefined,
  thread: {
    threadId: ThreadId.make("thread-1"),
    providerSessionId: "provider-session-1",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
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
  Layer.provideMerge(
    Layer.mergeAll(
      McpServer.McpServer.layer,
      Layer.succeed(ThreadManagementService.ThreadManagementService, {
        getThreadShell: () => Effect.succeed(null),
      } as unknown as ThreadManagementService.ThreadManagementService["Service"]),
    ),
  ),
);

const builtInFixtureToolkit = Toolkit.make(
  Tool.make(fixtureTool.name, {
    description: "Existing built-in fixture tool.",
    parameters: EmptyIntegrationToolInput,
    success: Schema.Unknown,
  }),
);
const serverWithBuiltInFixture = toolkitRegistration(
  builtInFixtureToolkit,
  McpToolAccess.toLayer(builtInFixtureToolkit, {
    "fixture.read": McpToolAccess.reads(() => Effect.succeed({ existing: true })),
  }),
).pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      McpServer.McpServer.layer,
      Layer.succeed(ThreadManagementService.ThreadManagementService, {
        getThreadShell: () => Effect.succeed(null),
      } as unknown as ThreadManagementService.ThreadManagementService["Service"]),
    ),
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
          Layer.provideMerge(
            Layer.mergeAll(
              McpServer.McpServer.layer,
              Layer.succeed(ThreadManagementService.ThreadManagementService, {
                getThreadShell: () => Effect.succeed(null),
              } as unknown as ThreadManagementService.ThreadManagementService["Service"]),
            ),
          ),
        ),
      ),
    ),
  ),
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
          Layer.provideMerge(
            Layer.mergeAll(
              McpServer.McpServer.layer,
              Layer.succeed(ThreadManagementService.ThreadManagementService, {
                getThreadShell: () => Effect.succeed(null),
              } as unknown as ThreadManagementService.ThreadManagementService["Service"]),
            ),
          ),
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
            Layer.provideMerge(
              Layer.mergeAll(
                McpServer.McpServer.layer,
                Layer.succeed(ThreadManagementService.ThreadManagementService, {
                  getThreadShell: () => Effect.succeed(null),
                } as unknown as ThreadManagementService.ThreadManagementService["Service"]),
              ),
            ),
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

// regression: fc95a4c143 fix(server): bound model-facing integration results
it.effect("preserves bounded results and reports omitted results as completed MCP calls", () => {
  const invokeTool = vi
    .fn<Integrations.RegistryRuntime["invokeTool"]>()
    .mockResolvedValueOnce({ records: [{ id: "record-1" }] })
    .mockResolvedValueOnce(Integrations.INTEGRATION_TOOL_RESULT_OMITTED);
  const registrySpy = vi.spyOn(Integrations, "getIntegrationRegistry").mockReturnValue({
    invokeTool,
  } as unknown as Integrations.RegistryRuntime);
  const authorized = invocation(new Set(["integrations.invoke"]));

  return Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const bounded = yield* server
        .callTool({ name: "fixture.read", arguments: {} })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, authorized),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(bounded.isError).toBe(false);
      expect(bounded.structuredContent).toEqual({ records: [{ id: "record-1" }] });
      expect(bounded.content).toEqual([{ type: "text", text: '{"records":[{"id":"record-1"}]}' }]);

      const omitted = yield* server
        .callTool({ name: "fixture.read", arguments: {} })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, authorized),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(omitted.isError).toBe(false);
      expect(omitted.structuredContent).toEqual(Integrations.INTEGRATION_TOOL_RESULT_OMITTED);
      expect(omitted.content).toEqual([
        {
          type: "text",
          text: '{"resultOmitted":true,"reason":"integration_tool_result_omitted","message":"Integration tool completed, but its result was omitted."}',
        },
      ]);
      expect(invokeTool).toHaveBeenCalledTimes(2);
    }).pipe(Effect.provide(testLayer)),
  ).pipe(Effect.ensuring(Effect.sync(() => registrySpy.mockRestore())));
});

// regression: #304 fix(server): show agents why integration tool calls fail
it.effect("tells MCP agents why a call failed only through safe errors", () => {
  const invokeTool = vi
    .fn<Integrations.RegistryRuntime["invokeTool"]>()
    .mockRejectedValueOnce(
      new IntegrationOperationError({
        code: "invalid_input",
        message:
          "Input for integration tool fixture.read did not match its declared schema: operations[0].changes: unexpected property",
      }),
    )
    .mockRejectedValueOnce(
      new Integrations.IntegrationProviderPublicError("Workflow wf-1 was not found."),
    )
    .mockRejectedValueOnce(new Error("401 from https://n8n.invalid?token=SECRET_TOKEN"));
  const registrySpy = vi.spyOn(Integrations, "getIntegrationRegistry").mockReturnValue({
    invokeTool,
  } as unknown as Integrations.RegistryRuntime);
  const authorized = invocation(new Set(["integrations.invoke"]));

  return Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const call = server
        .callTool({ name: "fixture.read", arguments: {} })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, authorized),
          Effect.provideService(McpSchema.McpServerClient, client),
        );

      const invalid = yield* call;
      expect(invalid.isError).toBe(true);
      expect(invalid.structuredContent).toEqual({ error: "invalid_input" });
      expect(invalid.content).toEqual([
        {
          type: "text",
          text: "Integration tool call failed (invalid_input): Input for integration tool fixture.read did not match its declared schema: operations[0].changes: unexpected property",
        },
      ]);

      const providerFailure = yield* call;
      expect(providerFailure.isError).toBe(true);
      expect(providerFailure.structuredContent).toEqual({ error: "provider_error" });
      expect(providerFailure.content).toEqual([
        { type: "text", text: "Integration tool call failed: Workflow wf-1 was not found." },
      ]);

      const unknown = yield* call;
      expect(unknown.isError).toBe(true);
      expect(unknown.structuredContent).toEqual({ error: "integration_tool_failed" });
      expect(unknown.content).toEqual([{ type: "text", text: "Tool call failed." }]);
    }).pipe(Effect.provide(testLayer)),
  ).pipe(Effect.ensuring(Effect.sync(() => registrySpy.mockRestore())));
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
          Effect.provideService(McpSchema.McpServerClient, client),
          Effect.flip,
        );
      expect(result).toBeInstanceOf(McpSchema.InvalidParams);
      expect(result.message).toContain("not found");
    }).pipe(Effect.provide(testLayer)),
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
          Effect.provideService(McpSchema.McpServerClient, client),
          Effect.flip,
        );
      expect(result).toBeInstanceOf(McpSchema.InvalidParams);
      expect(result.message).toContain("not found");
      expect(availabilityChecks).toBe(2);
    }).pipe(
      Effect.provide(
        registrationLayerFor([fixtureTool], unavailable).pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              McpServer.McpServer.layer,
              Layer.succeed(ThreadManagementService.ThreadManagementService, {
                getThreadShell: () => Effect.succeed(null),
              } as unknown as ThreadManagementService.ThreadManagementService["Service"]),
            ),
          ),
        ),
      ),
    ),
  );
});

it.effect.each([
  "read-only",
  "approval-required",
  "auto-accept-edits",
  "auto",
  "full-access",
] as const)("denies an outside plugin write without a host presenter: %s", (access) => {
  const invokeTool = vi
    .fn<Integrations.RegistryRuntime["invokeTool"]>()
    .mockResolvedValue({ ok: true });
  const registrySpy = vi
    .spyOn(Integrations, "getIntegrationRegistry")
    .mockReturnValue({ invokeTool } as unknown as Integrations.RegistryRuntime);
  const scope: McpInvocationContext.McpInvocationScope = {
    ...invocation(new Set(["integrations.invoke"])),
    thread: undefined,
    client: { sessionId: "outside-read", label: "fixture", access },
  };
  return Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const result = yield* server
        .callTool({ name: writeFixtureTool.name, arguments: {} })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toEqual({ error: "capability_denied" });
      expect(invokeTool).not.toHaveBeenCalled();
    }).pipe(
      Effect.provide(
        registrationLayerFor([writeFixtureTool], () => true).pipe(
          Layer.provideMerge(Layer.mergeAll(McpServer.McpServer.layer, liveThreadsLayer)),
        ),
      ),
    ),
  ).pipe(Effect.ensuring(Effect.sync(() => registrySpy.mockRestore())));
});

it.effect.each([true, false])(
  "permits a plugin write only while the provider owns a live run: %s",
  (active) => {
    const invokeTool = vi
      .fn<Integrations.RegistryRuntime["invokeTool"]>()
      .mockResolvedValue({ ok: true });
    const registrySpy = vi
      .spyOn(Integrations, "getIntegrationRegistry")
      .mockReturnValue({ invokeTool } as unknown as Integrations.RegistryRuntime);
    const scope = invocation(new Set(["integrations.invoke"]));
    const threads = Layer.mock(ThreadManagementService.ThreadManagementService)({
      getThreadShell: (threadId) =>
        Effect.succeed(liveThreadShell(threadId, active ? {} : { activeRunId: null })),
    });
    return Effect.scoped(
      Effect.gen(function* () {
        const server = yield* McpServer.McpServer;
        const result = yield* server
          .callTool({ name: writeFixtureTool.name, arguments: {} })
          .pipe(
            Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
            Effect.provideService(McpSchema.McpServerClient, client),
          );
        expect(result.isError).toBe(!active);
        if (active)
          expect(invokeTool).toHaveBeenCalledWith(
            writeFixtureTool.name,
            {},
            expect.objectContaining({ approvalOwner: scope.thread }),
          );
        else {
          expect(result.structuredContent).toEqual({ error: "parent_not_active" });
          expect(invokeTool).not.toHaveBeenCalled();
        }
      }).pipe(
        Effect.provide(
          registrationLayerFor([writeFixtureTool], () => true).pipe(
            Layer.provideMerge(Layer.mergeAll(McpServer.McpServer.layer, threads)),
          ),
        ),
      ),
    ).pipe(Effect.ensuring(Effect.sync(() => registrySpy.mockRestore())));
  },
);
