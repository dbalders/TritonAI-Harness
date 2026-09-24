// @effect-diagnostics nodeBuiltinImport:off
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  ApprovalRequestId,
  CodexSettings,
  EnvironmentId,
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderItemId,
  type ProviderApprovalDecision,
  type ProviderEvent,
  type ProviderSetThreadGoalInput,
  type ProviderSession,
  type ProviderTurnStartResult,
  type ProviderUserInputAnswers,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, vi } from "@effect/vitest";

import * as Context from "effect/Context";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as CodexErrors from "effect-codex-app-server/errors";

import { ServerConfig } from "../../config.ts";
import {
  codexDynamicIntegrationToolName,
  INTEGRATION_TOOL_RESULT_OMITTED,
  type RegistryRuntime,
} from "../../integrations/IntegrationRegistry.ts";
import { EmptyIntegrationToolInput } from "../../integrations/IntegrationTool.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import * as PreviewAutomationBroker from "../../mcp/PreviewAutomationBroker.ts";
import { TRITONAI_COMMONS_SUBMIT_TOOL_NAME } from "../../mcp/TritonAiCommonsTool.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ProviderAdapterValidationError } from "../Errors.ts";
import type { CodexAdapterShape } from "../Services/CodexAdapter.ts";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";
import {
  type CodexSessionRuntimeOptions,
  type CodexSessionRuntimeSendTurnInput,
  type CodexSessionRuntimeShape,
  type CodexThreadSnapshot,
} from "./CodexSessionRuntime.ts";
import { createStdioMcpServerArgs, makeCodexAdapter } from "./CodexAdapter.ts";
import {
  CodexImageContextAnalysisError,
  makeCodexImageContextAnalyzer,
  type CodexImageContextAnalyzer,
} from "./CodexImageContext.ts";
const decodeCodexSettings = Schema.decodeSync(CodexSettings);

it("flattens plugin component names into provider-safe function names", () => {
  NodeAssert.equal(
    codexDynamicIntegrationToolName("fixture.records.search"),
    "fixture_records_search",
  );
});

it("encodes the embedded Cua Driver as a Codex stdio MCP server", () => {
  NodeAssert.deepEqual(
    createStdioMcpServerArgs("cua-driver", {
      command: "/Applications/TritonAI Harness.app/Contents/Resources/cua-driver/cua-driver",
      args: ["mcp", "--socket", "/tmp/cua driver.sock"],
      environment: {},
    }),
    [
      "-c",
      'mcp_servers.cua-driver.command="/Applications/TritonAI Harness.app/Contents/Resources/cua-driver/cua-driver"',
      "-c",
      'mcp_servers.cua-driver.args=["mcp","--socket","/tmp/cua driver.sock"]',
    ],
  );
});

// Test-local service tag so the rest of the file can keep using `yield* CodexAdapter`.
class CodexAdapter extends Context.Service<CodexAdapter, CodexAdapterShape>()(
  "t3/provider/Layers/CodexAdapter.test/CodexAdapter",
) {}

const asThreadId = (value: string): ThreadId => ThreadId.make(value);
const asTurnId = (value: string): TurnId => TurnId.make(value);
const asEventId = (value: string): EventId => EventId.make(value);
const asItemId = (value: string): ProviderItemId => ProviderItemId.make(value);

class FakeCodexRuntime implements CodexSessionRuntimeShape {
  private readonly eventQueue = Effect.runSync(Queue.unbounded<ProviderEvent>());
  private readonly now = "2026-01-01T00:00:00.000Z";
  private currentModel: string | undefined;
  public sessionStatus: ProviderSession["status"] = "ready";
  public activeTurnId: TurnId | undefined;
  public onStart: (() => Effect.Effect<void>) | undefined;
  public onGetSession: (() => void | Promise<void>) | undefined;

  public readonly startImpl = vi.fn(() =>
    Promise.resolve({
      provider: ProviderDriverKind.make("codex"),
      status: this.sessionStatus,
      runtimeMode: this.options.runtimeMode,
      threadId: this.options.threadId,
      cwd: this.options.cwd,
      ...(this.currentModel ? { model: this.currentModel } : {}),
      resumeCursor: this.options.resumeCursor ?? { threadId: "provider-thread-1" },
      createdAt: this.now,
      updatedAt: this.now,
      ...(this.activeTurnId ? { activeTurnId: this.activeTurnId } : {}),
    } satisfies ProviderSession),
  );

  public readonly sendTurnImpl = vi.fn(
    (input: CodexSessionRuntimeSendTurnInput): Promise<ProviderTurnStartResult> => {
      if (input.model) {
        this.currentModel = input.model;
      }
      return Promise.resolve({
        threadId: this.options.threadId,
        turnId: asTurnId("turn-1"),
        resumeCursor: this.options.resumeCursor ?? { threadId: "provider-thread-1" },
      });
    },
  );

  public readonly compactThread = Effect.void;

  public readonly interruptTurnImpl = vi.fn((_turnId?: TurnId): Promise<void> =>
    Promise.resolve(undefined),
  );

  public readonly readThreadImpl = vi.fn((): Promise<CodexThreadSnapshot> =>
    Promise.resolve({
      threadId: "provider-thread-1",
      turns: [],
    }),
  );

  public readonly rollbackThreadImpl = vi.fn((_numTurns: number): Promise<CodexThreadSnapshot> =>
    Promise.resolve({
      threadId: "provider-thread-1",
      turns: [],
    }),
  );

  public readonly uploadFeedbackImpl = vi.fn((_reason?: string) =>
    Promise.resolve({ threadId: "provider-thread-1" }),
  );

  public readonly setThreadGoalImpl = vi.fn(
    (_input: Omit<ProviderSetThreadGoalInput, "threadId">): Promise<void> =>
      Promise.resolve(undefined),
  );

  public readonly clearThreadGoalImpl = vi.fn((): Promise<void> => Promise.resolve(undefined));
  public readonly respondToRequestImpl = vi.fn(
    (_requestId: ApprovalRequestId, _decision: ProviderApprovalDecision): Promise<void> =>
      Promise.resolve(undefined),
  );

  public readonly respondToUserInputImpl = vi.fn(
    (_requestId: ApprovalRequestId, _answers: ProviderUserInputAnswers): Promise<void> =>
      Promise.resolve(undefined),
  );

  public readonly closeImpl = vi.fn(() => Promise.resolve(undefined));

  readonly options: CodexSessionRuntimeOptions;

  constructor(options: CodexSessionRuntimeOptions) {
    this.options = options;
    this.currentModel = options.model;
  }

  start() {
    const onStart = this.onStart;
    const startImpl = this.startImpl;
    return Effect.gen(function* () {
      if (onStart) {
        yield* onStart();
      }
      return yield* Effect.promise(() => startImpl());
    });
  }

  getSession = Effect.promise(async () => {
    await this.onGetSession?.();
    return this.startImpl();
  });

  sendTurn(input: CodexSessionRuntimeSendTurnInput) {
    return Effect.promise(() => this.sendTurnImpl(input));
  }

  interruptTurn(turnId?: TurnId) {
    return Effect.promise(() => this.interruptTurnImpl(turnId));
  }

  readThread = Effect.promise(() => this.readThreadImpl());

  rollbackThread(numTurns: number) {
    return Effect.promise(() => this.rollbackThreadImpl(numTurns));
  }

  uploadFeedback(reason?: string) {
    return Effect.promise(() => this.uploadFeedbackImpl(reason));
  }

  setThreadGoal(input: Omit<ProviderSetThreadGoalInput, "threadId">) {
    return Effect.promise(() => this.setThreadGoalImpl(input));
  }

  clearThreadGoal = Effect.promise(() => this.clearThreadGoalImpl());
  respondToRequest(requestId: ApprovalRequestId, decision: ProviderApprovalDecision) {
    return Effect.promise(() => this.respondToRequestImpl(requestId, decision));
  }

  respondToUserInput(requestId: ApprovalRequestId, answers: ProviderUserInputAnswers) {
    return Effect.promise(() => this.respondToUserInputImpl(requestId, answers));
  }

  get events() {
    return Stream.fromQueue(this.eventQueue);
  }

  close = Effect.promise(() => this.closeImpl());

  emit(event: ProviderEvent) {
    return Queue.offer(this.eventQueue, event).pipe(Effect.asVoid);
  }
}

function makeRuntimeFactory() {
  const runtimes: Array<FakeCodexRuntime> = [];
  let configureNextRuntime: ((runtime: FakeCodexRuntime) => void) | undefined;
  const factory = vi.fn(
    (
      options: CodexSessionRuntimeOptions,
    ): Effect.Effect<FakeCodexRuntime, CodexErrors.CodexAppServerSpawnError> => {
      const runtime = new FakeCodexRuntime(options);
      configureNextRuntime?.(runtime);
      configureNextRuntime = undefined;
      runtimes.push(runtime);
      return Effect.succeed(runtime);
    },
  );

  return {
    factory,
    configureNextRuntime(configure: (runtime: FakeCodexRuntime) => void) {
      configureNextRuntime = configure;
    },
    get lastRuntime(): FakeCodexRuntime | undefined {
      return runtimes.at(-1);
    },
  };
}

function makeScopedRuntimeFactory(options?: { readonly failConstruction?: boolean }) {
  const runtimes: Array<FakeCodexRuntime> = [];
  const releasedThreadIds: Array<ThreadId> = [];

  const factory = vi.fn((runtimeOptions: CodexSessionRuntimeOptions) =>
    Effect.gen(function* () {
      yield* Scope.Scope;
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          releasedThreadIds.push(runtimeOptions.threadId);
        }),
      );

      if (options?.failConstruction) {
        return yield* new CodexErrors.CodexAppServerSpawnError({
          command: `${runtimeOptions.binaryPath} app-server`,
          cause: new Error("runtime construction failed"),
        });
      }

      const runtime = new FakeCodexRuntime(runtimeOptions);
      runtimes.push(runtime);
      return runtime;
    }),
  );

  return {
    factory,
    releasedThreadIds,
    get lastRuntime(): FakeCodexRuntime | undefined {
      return runtimes.at(-1);
    },
  };
}

const providerSessionDirectoryTestLayer = Layer.succeed(ProviderSessionDirectory, {
  upsert: () => Effect.void,
  recordImportedTranscript: () => Effect.die("unused"),
  getProvider: () =>
    Effect.die(new Error("ProviderSessionDirectory.getProvider is not used in test")),
  getBinding: () => Effect.succeed(Option.none()),
  listThreadIds: () => Effect.succeed([]),
  listBindings: () => Effect.succeed([]),
});

const validationRuntimeFactory = makeRuntimeFactory();
const validationLayer = it.layer(
  Layer.effect(
    CodexAdapter,
    Effect.gen(function* () {
      const codexConfig = decodeCodexSettings({ customModels: ["managed-model"] });
      const previewAutomationBroker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
      return yield* makeCodexAdapter(codexConfig, {
        makeRuntime: validationRuntimeFactory.factory,
        previewAutomationBroker,
      });
    }),
  ).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(providerSessionDirectoryTestLayer),
    Layer.provideMerge(PreviewAutomationBroker.layer),
    Layer.provideMerge(NodeServices.layer),
  ),
);

validationLayer("CodexAdapterLive validation", (it) => {
  it.effect("returns validation error for non-codex provider on startSession", () =>
    Effect.gen(function* () {
      validationRuntimeFactory.factory.mockClear();
      const adapter = yield* CodexAdapter;
      const threadId = asThreadId("thread-invalid-restart");
      yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
      const runtime = validationRuntimeFactory.lastRuntime!;
      const result = yield* adapter
        .startSession({
          provider: ProviderDriverKind.make("claudeAgent"),
          threadId,
          runtimeMode: "full-access",
        })
        .pipe(Effect.result);

      NodeAssert.equal(result._tag, "Failure");
      NodeAssert.deepStrictEqual(
        result.failure,
        new ProviderAdapterValidationError({
          provider: ProviderDriverKind.make("codex"),
          operation: "startSession",
          issue: "Expected provider 'codex' but received 'claudeAgent'.",
        }),
      );
      yield* adapter.sendTurn({ threadId, input: "still live", attachments: [] });
      NodeAssert.equal(validationRuntimeFactory.factory.mock.calls.length, 1);
      NodeAssert.equal(runtime.sendTurnImpl.mock.calls.length, 1);
    }),
  );
  it.effect("maps codex model options before starting a session", () =>
    Effect.gen(function* () {
      validationRuntimeFactory.factory.mockClear();
      const adapter = yield* CodexAdapter;

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.3-codex", [
          { id: "serviceTier", value: "priority" },
        ]),
        runtimeMode: "full-access",
      });

      const runtimeOptions = validationRuntimeFactory.factory.mock.calls[0]?.[0];
      NodeAssert.ok(runtimeOptions);
      const { dynamicTools, invokeDynamicTool, isDynamicToolAvailable, ...transportOptions } =
        runtimeOptions;
      NodeAssert.deepStrictEqual(transportOptions, {
        binaryPath: "codex",
        cwd: process.cwd(),
        launchArgs: "",
        model: "gpt-5.3-codex",
        providerInstanceId: ProviderInstanceId.make("codex"),
        serviceTier: "priority",
        threadId: asThreadId("thread-1"),
        runtimeMode: "full-access",
      });
      NodeAssert.deepStrictEqual(
        dynamicTools?.map(({ name }) => name),
        [TRITONAI_COMMONS_SUBMIT_TOOL_NAME],
      );
      NodeAssert.equal(typeof invokeDynamicTool, "function");
      NodeAssert.equal(isDynamicToolAvailable?.(TRITONAI_COMMONS_SUBMIT_TOOL_NAME), true);
    }),
  );
  it.effect("enables the collaborative browser MCP namespace by default", () =>
    Effect.gen(function* () {
      validationRuntimeFactory.factory.mockClear();
      const adapter = yield* CodexAdapter;
      const threadId = asThreadId("thread-mcp-namespace-enabled");
      McpProviderSession.setMcpProviderSession({
        environmentId: EnvironmentId.make("environment-1"),
        threadId,
        providerSessionId: "provider-session-1",
        providerInstanceId: ProviderInstanceId.make("codex"),
        endpoint: "http://127.0.0.1:43123/mcp",
        capabilities: new Set(["preview"] as const),
        authorizationHeader: "Bearer test-token",
      });

      try {
        yield* adapter.startSession({
          provider: ProviderDriverKind.make("codex"),
          threadId,
          runtimeMode: "full-access",
        });

        const runtimeOptions = validationRuntimeFactory.factory.mock.calls[0]?.[0];
        NodeAssert.ok(runtimeOptions);
        const { dynamicTools, invokeDynamicTool, isDynamicToolAvailable, ...transportOptions } =
          runtimeOptions;
        NodeAssert.deepStrictEqual(transportOptions, {
          mcpCapabilities: new Set(["preview"]),
          appServerArgs: [
            "-c",
            "mcp_servers.t3-code.url=http://127.0.0.1:43123/mcp",
            "-c",
            'mcp_servers.t3-code.bearer_token_env_var="T3_MCP_BEARER_TOKEN"',
          ],
          binaryPath: "codex",
          launchArgs: "",
          cwd: process.cwd(),
          environment: {
            ...process.env,
            T3_MCP_BEARER_TOKEN: "test-token",
          },
          providerInstanceId: ProviderInstanceId.make("codex"),
          threadId,
          runtimeMode: "full-access",
        });
        NodeAssert.deepStrictEqual(
          dynamicTools?.map(({ name }) => name),
          [TRITONAI_COMMONS_SUBMIT_TOOL_NAME],
        );
        NodeAssert.equal(typeof invokeDynamicTool, "function");
        NodeAssert.equal(isDynamicToolAvailable?.(TRITONAI_COMMONS_SUBMIT_TOOL_NAME), true);
      } finally {
        McpProviderSession.clearMcpProviderSession(threadId);
      }
    }),
  );
  it.effect("exposes collaborative browser tools as flat functions for managed models", () =>
    Effect.gen(function* () {
      validationRuntimeFactory.factory.mockClear();
      const adapter = yield* CodexAdapter;
      const threadId = asThreadId("thread-managed-browser-tools");
      McpProviderSession.setMcpProviderSession({
        environmentId: EnvironmentId.make("environment-managed-browser"),
        threadId,
        providerSessionId: "provider-session-managed-browser",
        providerInstanceId: ProviderInstanceId.make("codex"),
        endpoint: "http://127.0.0.1:43123/mcp",
        capabilities: new Set(["preview"] as const),
        authorizationHeader: ["Bearer", "test-token"].join(" "),
      });
      try {
        yield* adapter.startSession({
          provider: ProviderDriverKind.make("codex"),
          threadId,
          modelSelection: createModelSelection(
            ProviderInstanceId.make("codex"),
            "managed-model",
            [],
          ),
          runtimeMode: "full-access",
        });

        const runtimeOptions = validationRuntimeFactory.factory.mock.calls[0]?.[0];
        NodeAssert.ok(runtimeOptions);
        NodeAssert.deepStrictEqual(runtimeOptions.appServerArgs, ["-c", 'web_search="disabled"']);
        NodeAssert.deepStrictEqual(
          runtimeOptions.dynamicTools?.map(({ name }) => name),
          [
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
            TRITONAI_COMMONS_SUBMIT_TOOL_NAME,
          ],
        );
        NodeAssert.equal(runtimeOptions.dynamicTools?.[0]?.requiresApproval, false);
        NodeAssert.equal(
          runtimeOptions.dynamicTools?.find(({ name }) => name === "preview_click")
            ?.requiresApproval,
          true,
        );
        NodeAssert.equal(
          runtimeOptions.dynamicTools?.find(
            ({ name }) => name === TRITONAI_COMMONS_SUBMIT_TOOL_NAME,
          )?.requiresApproval,
          true,
        );
        NodeAssert.equal(runtimeOptions.isDynamicToolAvailable?.("preview_status"), true);
        NodeAssert.equal(runtimeOptions.environment, undefined);
      } finally {
        McpProviderSession.clearMcpProviderSession(threadId);
      }
    }),
  );
  it.effect("keeps managed transport settings when preview tools are unavailable", () =>
    Effect.gen(function* () {
      validationRuntimeFactory.factory.mockClear();
      const adapter = yield* CodexAdapter;

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-managed-browser-unavailable"),
        modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "managed-model", []),
        runtimeMode: "full-access",
      });

      const runtimeOptions = validationRuntimeFactory.factory.mock.calls[0]?.[0];
      NodeAssert.ok(runtimeOptions);
      NodeAssert.deepStrictEqual(runtimeOptions.appServerArgs, ["-c", 'web_search="disabled"']);
      NodeAssert.deepStrictEqual(
        runtimeOptions.dynamicTools?.map(({ name }) => name),
        [TRITONAI_COMMONS_SUBMIT_TOOL_NAME],
      );
      NodeAssert.equal(runtimeOptions.environment, undefined);
    }),
  );
});

const computerUseRuntimeFactory = makeRuntimeFactory();
const computerUseLayer = it.layer(
  Layer.effect(
    CodexAdapter,
    makeCodexAdapter(decodeCodexSettings({}), {
      environment: { EXISTING_ENV: "preserved" },
      makeRuntime: computerUseRuntimeFactory.factory,
    }),
  ).pipe(
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), process.cwd(), {
        computerUseMcp: {
          command: "/Applications/TritonAI Harness.app/Contents/Resources/cua-driver/cua-driver",
          args: ["mcp", "--socket", "/tmp/cua driver.sock"],
          environment: {
            CUA_DRIVER_RS_TELEMETRY_ENABLED: "false",
            CUA_DRIVER_RS_UPDATE_CHECK: "false",
          },
        },
      }),
    ),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(providerSessionDirectoryTestLayer),
    Layer.provideMerge(NodeServices.layer),
  ),
);

computerUseLayer("CodexAdapterLive computer use", (it) => {
  it.effect("passes the desktop Cua MCP contract into the Codex runtime", () =>
    Effect.gen(function* () {
      computerUseRuntimeFactory.factory.mockClear();
      const adapter = yield* CodexAdapter;
      const threadId = asThreadId("thread-computer-use");

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("codex"),
        threadId,
        runtimeMode: "full-access",
      });

      const runtimeOptions = computerUseRuntimeFactory.lastRuntime?.options;
      NodeAssert.ok(runtimeOptions);
      NodeAssert.deepStrictEqual(runtimeOptions.appServerArgs, [
        "-c",
        'mcp_servers.cua-driver.command="/Applications/TritonAI Harness.app/Contents/Resources/cua-driver/cua-driver"',
        "-c",
        'mcp_servers.cua-driver.args=["mcp","--socket","/tmp/cua driver.sock"]',
        "-c",
        'mcp_servers.cua-driver.env={"CUA_DRIVER_RS_TELEMETRY_ENABLED"="false","CUA_DRIVER_RS_UPDATE_CHECK"="false"}',
      ]);
      NodeAssert.deepStrictEqual(runtimeOptions.environment, {
        EXISTING_ENV: "preserved",
      });
    }),
  );
});

const reconciliationRuntimeFactory = makeRuntimeFactory();
const reconciliationAvailability = {
  generation: 0,
  available: false,
  writeAvailable: false,
  advancesDuringPrepare: 0,
};
const reconciliationToolName = "fixture.records.search";
const reconciliationWriteToolName = "fixture.records.write";
const reconciliationInvokeTool = vi.fn<RegistryRuntime["invokeTool"]>(() =>
  Promise.resolve({ records: [] }),
);
const reconciliationRegistry = {
  get availabilityGeneration() {
    return reconciliationAvailability.generation;
  },
  prepareSkillRuntime: () => {
    if (reconciliationAvailability.advancesDuringPrepare > 0) {
      reconciliationAvailability.advancesDuringPrepare -= 1;
      reconciliationAvailability.generation += 1;
    }
    return Promise.resolve(null);
  },
  releaseSkillRuntime: () => Promise.resolve(),
  toolDefinitions: () => [
    {
      name: reconciliationToolName,
      description: "Search fixture records.",
      input: EmptyIntegrationToolInput,
      readOnly: true,
      openWorld: false,
    },
    {
      name: reconciliationWriteToolName,
      description: "Change fixture records.",
      input: EmptyIntegrationToolInput,
      readOnly: false,
      openWorld: false,
    },
  ],
  isToolAvailableSync: (name: string) =>
    name === reconciliationWriteToolName
      ? reconciliationAvailability.writeAvailable
      : reconciliationAvailability.available,
  // Approval policy is deliberately independent from the provider's write classification.
  toolRequiresApprovalSync: () => false,
  isSkillAvailableSync: () => false,
  reserveSkillsSync: () => null,
  invokeTool: reconciliationInvokeTool,
} as unknown as RegistryRuntime;
let resolvedReconciliationRegistry: RegistryRuntime = reconciliationRegistry;

const replacementReconciliationRegistry = {
  availabilityGeneration: 0,
  prepareSkillRuntime: () => Promise.resolve(null),
  releaseSkillRuntime: () => Promise.resolve(),
  toolDefinitions: () => [
    {
      name: reconciliationToolName,
      description: "Search fixture records.",
      input: EmptyIntegrationToolInput,
      readOnly: true,
      openWorld: false,
    },
  ],
  isToolAvailableSync: () => true,
  isSkillAvailableSync: () => false,
  reserveSkillsSync: () => null,
  invokeTool: () => Promise.resolve({ records: [] }),
} as unknown as RegistryRuntime;

const reconciliationLayer = it.layer(
  Layer.effect(
    CodexAdapter,
    makeCodexAdapter(decodeCodexSettings({}), {
      makeRuntime: reconciliationRuntimeFactory.factory,
      resolveIntegrationRegistry: () => resolvedReconciliationRegistry,
    }),
  ).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(providerSessionDirectoryTestLayer),
    Layer.provideMerge(NodeServices.layer),
  ),
);

reconciliationLayer("CodexAdapter integration availability reconciliation", (it) => {
  it.effect("forwards the registry result through the direct dynamic-tool path", () =>
    Effect.gen(function* () {
      reconciliationAvailability.generation = 1;
      reconciliationAvailability.available = true;
      reconciliationAvailability.writeAvailable = false;
      reconciliationAvailability.advancesDuringPrepare = 0;
      reconciliationRuntimeFactory.factory.mockClear();
      reconciliationInvokeTool.mockClear();
      reconciliationInvokeTool.mockResolvedValueOnce(INTEGRATION_TOOL_RESULT_OMITTED);
      const adapter = yield* CodexAdapter;
      const threadId = asThreadId("thread-bounded-integration-result");

      yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
      const runtime = reconciliationRuntimeFactory.lastRuntime!;
      const binding = runtime.options.dynamicTools?.find(
        ({ name }) => name === codexDynamicIntegrationToolName(reconciliationToolName),
      );
      const signal = new AbortController().signal;
      const result = yield* Effect.promise(() =>
        runtime.options.invokeDynamicTool!({
          name: binding!.name,
          arguments: { query: "bounded" },
          signal,
        }),
      );

      NodeAssert.strictEqual(result, INTEGRATION_TOOL_RESULT_OMITTED);
      NodeAssert.deepStrictEqual(reconciliationInvokeTool.mock.calls, [
        [reconciliationToolName, { query: "bounded" }, { signal }],
      ]);
    }),
  );

  it.effect("does not disclose disabled write tools to Codex", () =>
    Effect.gen(function* () {
      reconciliationAvailability.generation = 1;
      reconciliationAvailability.available = true;
      reconciliationAvailability.writeAvailable = false;
      reconciliationAvailability.advancesDuringPrepare = 0;
      reconciliationRuntimeFactory.factory.mockClear();
      const adapter = yield* CodexAdapter;
      const threadId = asThreadId("thread-disabled-integration-write-tool");

      try {
        yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
        NodeAssert.deepStrictEqual(
          reconciliationRuntimeFactory.lastRuntime?.options.dynamicTools?.map(({ name }) => name),
          [
            TRITONAI_COMMONS_SUBMIT_TOOL_NAME,
            codexDynamicIntegrationToolName(reconciliationToolName),
          ],
        );

        reconciliationAvailability.writeAvailable = true;
        reconciliationAvailability.generation = 2;
        yield* adapter.sendTurn({ threadId, input: "enable write access", attachments: [] });
        NodeAssert.deepStrictEqual(
          reconciliationRuntimeFactory.lastRuntime?.options.dynamicTools?.map(({ name }) => name),
          [
            TRITONAI_COMMONS_SUBMIT_TOOL_NAME,
            codexDynamicIntegrationToolName(reconciliationToolName),
            codexDynamicIntegrationToolName(reconciliationWriteToolName),
          ],
        );

        reconciliationAvailability.writeAvailable = false;
        reconciliationAvailability.generation = 3;
        yield* adapter.sendTurn({ threadId, input: "disable write access", attachments: [] });
        NodeAssert.deepStrictEqual(
          reconciliationRuntimeFactory.lastRuntime?.options.dynamicTools?.map(({ name }) => name),
          [
            TRITONAI_COMMONS_SUBMIT_TOOL_NAME,
            codexDynamicIntegrationToolName(reconciliationToolName),
          ],
        );
      } finally {
        reconciliationAvailability.writeAvailable = false;
      }
    }),
  );

  it.effect("reconciles a live session when the integration registry is replaced", () =>
    Effect.gen(function* () {
      reconciliationAvailability.generation = 4;
      reconciliationAvailability.available = false;
      reconciliationAvailability.advancesDuringPrepare = 0;
      resolvedReconciliationRegistry = reconciliationRegistry;
      reconciliationRuntimeFactory.factory.mockClear();
      const adapter = yield* CodexAdapter;
      const threadId = asThreadId("thread-integration-registry-replacement");

      try {
        yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
        const initialRuntime = reconciliationRuntimeFactory.lastRuntime!;
        resolvedReconciliationRegistry = replacementReconciliationRegistry;

        yield* adapter.sendTurn({
          threadId,
          input: "use the replacement registry",
          attachments: [],
        });

        NodeAssert.equal(reconciliationRuntimeFactory.factory.mock.calls.length, 2);
        NodeAssert.equal(initialRuntime.closeImpl.mock.calls.length, 1);
        NodeAssert.equal(
          reconciliationRuntimeFactory.lastRuntime?.sendTurnImpl.mock.calls.length,
          1,
        );
      } finally {
        resolvedReconciliationRegistry = reconciliationRegistry;
      }
    }),
  );

  it.effect("captures the session lifecycle when a send effect begins", () =>
    Effect.gen(function* () {
      reconciliationAvailability.generation = 5;
      reconciliationAvailability.available = false;
      reconciliationAvailability.advancesDuringPrepare = 0;
      reconciliationRuntimeFactory.factory.mockClear();
      const adapter = yield* CodexAdapter;
      const threadId = asThreadId("thread-lazy-send-lifecycle");
      const send = adapter.sendTurn({ threadId, input: "after start", attachments: [] });

      yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
      yield* send;

      NodeAssert.equal(reconciliationRuntimeFactory.lastRuntime?.sendTurnImpl.mock.calls.length, 1);
    }),
  );

  it.effect("does not invalidate a live session when start validation fails", () =>
    Effect.gen(function* () {
      reconciliationAvailability.generation = 6;
      reconciliationAvailability.available = false;
      reconciliationAvailability.advancesDuringPrepare = 0;
      reconciliationRuntimeFactory.factory.mockClear();
      const adapter = yield* CodexAdapter;
      const threadId = asThreadId("thread-invalid-start-keeps-session");
      yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
      const runtime = reconciliationRuntimeFactory.lastRuntime!;
      const readStarted = Promise.withResolvers<void>();
      const releaseRead = Promise.withResolvers<void>();
      runtime.onGetSession = async () => {
        runtime.onGetSession = undefined;
        readStarted.resolve();
        await releaseRead.promise;
      };

      const send = yield* adapter
        .sendTurn({ threadId, input: "still valid", attachments: [] })
        .pipe(Effect.forkChild);
      yield* Effect.promise(() => readStarted.promise);
      const invalidStart = yield* Effect.exit(
        adapter.startSession({
          provider: ProviderDriverKind.make("invalid"),
          threadId,
          runtimeMode: "full-access",
        }),
      );
      NodeAssert.equal(Exit.isFailure(invalidStart), true);
      releaseRead.resolve();
      yield* Fiber.join(send);

      NodeAssert.equal(runtime.sendTurnImpl.mock.calls.length, 1);
      NodeAssert.equal(runtime.closeImpl.mock.calls.length, 0);
    }),
  );

  it.effect("reconciles when availability changes while a session starts", () =>
    Effect.gen(function* () {
      reconciliationAvailability.generation = 10;
      reconciliationAvailability.available = false;
      reconciliationAvailability.advancesDuringPrepare = 1;
      reconciliationRuntimeFactory.factory.mockClear();
      const adapter = yield* CodexAdapter;
      const threadId = asThreadId("thread-integration-start-race");
      yield* adapter.startSession({ threadId, runtimeMode: "full-access" });

      yield* adapter.sendTurn({ threadId, input: "use current plugin access", attachments: [] });

      NodeAssert.equal(reconciliationRuntimeFactory.factory.mock.calls.length, 2);
    }),
  );

  it.effect("rechecks availability when it changes during session reconciliation", () =>
    Effect.gen(function* () {
      reconciliationAvailability.generation = 20;
      reconciliationAvailability.available = false;
      reconciliationAvailability.advancesDuringPrepare = 0;
      reconciliationRuntimeFactory.factory.mockClear();
      const adapter = yield* CodexAdapter;
      const threadId = asThreadId("thread-integration-reconcile-race");
      yield* adapter.startSession({ threadId, runtimeMode: "full-access" });

      reconciliationAvailability.generation = 21;
      reconciliationAvailability.advancesDuringPrepare = 1;
      yield* adapter.sendTurn({ threadId, input: "use current plugin access", attachments: [] });

      NodeAssert.equal(reconciliationAvailability.generation, 22);
      NodeAssert.equal(reconciliationRuntimeFactory.factory.mock.calls.length, 3);
    }),
  );

  it.effect("rechecks availability immediately before dispatching an idle turn", () =>
    Effect.gen(function* () {
      reconciliationAvailability.generation = 30;
      reconciliationAvailability.available = false;
      reconciliationAvailability.advancesDuringPrepare = 0;
      reconciliationRuntimeFactory.factory.mockClear();
      const adapter = yield* CodexAdapter;
      const threadId = asThreadId("thread-integration-dispatch-race");
      yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
      const initialRuntime = reconciliationRuntimeFactory.lastRuntime!;
      initialRuntime.onGetSession = () => {
        initialRuntime.onGetSession = undefined;
        reconciliationAvailability.generation = 31;
      };

      yield* adapter.sendTurn({ threadId, input: "use current plugin access", attachments: [] });

      NodeAssert.equal(reconciliationRuntimeFactory.factory.mock.calls.length, 2);
    }),
  );

  it.effect("serializes concurrent reconciliation and dispatch for one thread", () =>
    Effect.gen(function* () {
      reconciliationAvailability.generation = 40;
      reconciliationAvailability.available = false;
      reconciliationAvailability.advancesDuringPrepare = 0;
      reconciliationRuntimeFactory.factory.mockClear();
      const adapter = yield* CodexAdapter;
      const threadId = asThreadId("thread-integration-concurrent-reconcile");
      yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
      const initialRuntime = reconciliationRuntimeFactory.lastRuntime!;
      const firstReadStarted = Promise.withResolvers<void>();
      const releaseFirstRead = Promise.withResolvers<void>();
      initialRuntime.onGetSession = async () => {
        initialRuntime.onGetSession = undefined;
        firstReadStarted.resolve();
        await releaseFirstRead.promise;
      };

      reconciliationAvailability.generation = 41;
      const firstSend = yield* adapter
        .sendTurn({ threadId, input: "first", attachments: [] })
        .pipe(Effect.forkChild);
      yield* Effect.promise(() => firstReadStarted.promise);
      const secondSend = yield* adapter
        .sendTurn({ threadId, input: "second", attachments: [] })
        .pipe(Effect.forkChild);
      const thirdSend = yield* adapter
        .sendTurn({ threadId, input: "third", attachments: [] })
        .pipe(Effect.forkChild);
      releaseFirstRead.resolve();
      yield* Fiber.join(firstSend);
      yield* Fiber.join(secondSend);
      yield* Fiber.join(thirdSend);

      NodeAssert.equal(reconciliationRuntimeFactory.factory.mock.calls.length, 2);
      NodeAssert.equal(reconciliationRuntimeFactory.lastRuntime?.sendTurnImpl.mock.calls.length, 3);
    }),
  );

  it.effect("does not invalidate a live turn when a queued restart is interrupted", () =>
    Effect.gen(function* () {
      reconciliationAvailability.generation = 45;
      reconciliationAvailability.available = false;
      reconciliationAvailability.advancesDuringPrepare = 0;
      reconciliationRuntimeFactory.factory.mockClear();
      const adapter = yield* CodexAdapter;
      const threadId = asThreadId("thread-interrupted-queued-restart");
      yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
      const runtime = reconciliationRuntimeFactory.lastRuntime!;
      const readStarted = Promise.withResolvers<void>();
      const releaseRead = Promise.withResolvers<void>();
      runtime.onGetSession = async () => {
        runtime.onGetSession = undefined;
        readStarted.resolve();
        await releaseRead.promise;
      };

      const send = yield* adapter
        .sendTurn({ threadId, input: "keep this turn", attachments: [] })
        .pipe(Effect.forkChild);
      yield* Effect.promise(() => readStarted.promise);
      const restart = yield* adapter
        .startSession({ threadId, runtimeMode: "full-access" })
        .pipe(Effect.forkChild);
      yield* Fiber.interrupt(restart);
      releaseRead.resolve();
      yield* Fiber.join(send);

      NodeAssert.equal(runtime.sendTurnImpl.mock.calls.length, 1);
      NodeAssert.equal(runtime.closeImpl.mock.calls.length, 0);
      NodeAssert.equal(reconciliationRuntimeFactory.factory.mock.calls.length, 1);
      NodeAssert.equal(yield* adapter.hasSession(threadId), true);
    }),
  );

  it.effect("keeps an earlier queued start when a later start is interrupted", () =>
    Effect.gen(function* () {
      reconciliationAvailability.generation = 47;
      reconciliationAvailability.available = false;
      reconciliationAvailability.advancesDuringPrepare = 0;
      reconciliationRuntimeFactory.factory.mockClear();
      const adapter = yield* CodexAdapter;
      const threadId = asThreadId("thread-independent-queued-starts");
      yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
      const runtime = reconciliationRuntimeFactory.lastRuntime!;
      const readStarted = Promise.withResolvers<void>();
      const releaseRead = Promise.withResolvers<void>();
      runtime.onGetSession = async () => {
        runtime.onGetSession = undefined;
        readStarted.resolve();
        await releaseRead.promise;
      };

      const send = yield* adapter
        .sendTurn({ threadId, input: "hold the thread lock", attachments: [] })
        .pipe(Effect.forkChild);
      yield* Effect.promise(() => readStarted.promise);
      const earlierStart = yield* adapter
        .startSession({ threadId, runtimeMode: "full-access" })
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      const laterStart = yield* adapter
        .startSession({ threadId, runtimeMode: "full-access" })
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(laterStart);

      releaseRead.resolve();
      yield* Fiber.await(send);
      yield* Fiber.join(earlierStart);

      NodeAssert.equal(reconciliationRuntimeFactory.factory.mock.calls.length, 2);
      NodeAssert.equal(yield* adapter.hasSession(threadId), true);
    }),
  );

  it.effect("does not make session teardown wait for a stalled send", () =>
    Effect.gen(function* () {
      reconciliationAvailability.generation = 50;
      reconciliationAvailability.available = false;
      reconciliationAvailability.advancesDuringPrepare = 0;
      reconciliationRuntimeFactory.factory.mockClear();
      const adapter = yield* CodexAdapter;
      const threadId = asThreadId("thread-stop-during-stalled-send");
      yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
      const runtime = reconciliationRuntimeFactory.lastRuntime!;
      const readStarted = Promise.withResolvers<void>();
      const releaseRead = Promise.withResolvers<void>();
      runtime.onGetSession = async () => {
        runtime.onGetSession = undefined;
        readStarted.resolve();
        await releaseRead.promise;
      };

      const send = yield* adapter
        .sendTurn({ threadId, input: "stalled", attachments: [] })
        .pipe(Effect.forkChild);
      yield* Effect.promise(() => readStarted.promise);
      yield* adapter.stopSession(threadId);
      NodeAssert.equal(runtime.closeImpl.mock.calls.length, 1);

      const sendExit = yield* Fiber.await(send);
      NodeAssert.equal(Exit.isFailure(sendExit), true);
      if (Exit.isFailure(sendExit)) {
        NodeAssert.equal(Cause.hasInterruptsOnly(sendExit.cause), true);
      }
      NodeAssert.equal(runtime.sendTurnImpl.mock.calls.length, 0);
      NodeAssert.equal(reconciliationRuntimeFactory.factory.mock.calls.length, 1);
      releaseRead.resolve();
    }),
  );

  it.effect("does not let teardown resurrect a queued session start", () =>
    Effect.gen(function* () {
      reconciliationAvailability.generation = 52;
      reconciliationAvailability.available = false;
      reconciliationAvailability.advancesDuringPrepare = 0;
      reconciliationRuntimeFactory.factory.mockClear();
      const adapter = yield* CodexAdapter;
      const threadId = asThreadId("thread-stop-with-queued-start");
      yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
      const runtime = reconciliationRuntimeFactory.lastRuntime!;
      const readStarted = Promise.withResolvers<void>();
      const releaseRead = Promise.withResolvers<void>();
      runtime.onGetSession = async () => {
        runtime.onGetSession = undefined;
        readStarted.resolve();
        await releaseRead.promise;
      };

      const send = yield* adapter
        .sendTurn({ threadId, input: "hold the thread lock", attachments: [] })
        .pipe(Effect.forkChild);
      yield* Effect.promise(() => readStarted.promise);
      const restart = yield* adapter
        .startSession({ threadId, runtimeMode: "full-access" })
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;

      yield* adapter.stopSession(threadId);
      yield* Fiber.await(send);
      const restartExit = yield* Fiber.await(restart);

      NodeAssert.equal(Exit.isFailure(restartExit), true);
      NodeAssert.equal(reconciliationRuntimeFactory.factory.mock.calls.length, 1);
      NodeAssert.equal(yield* adapter.hasSession(threadId), false);
      releaseRead.resolve();
    }),
  );

  it.effect("keeps a stalled provider close interruptible after claiming the session", () =>
    Effect.gen(function* () {
      reconciliationAvailability.generation = 55;
      reconciliationAvailability.available = false;
      reconciliationAvailability.advancesDuringPrepare = 0;
      reconciliationRuntimeFactory.factory.mockClear();
      const adapter = yield* CodexAdapter;
      const threadId = asThreadId("thread-interrupt-stalled-close");
      yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
      const runtime = reconciliationRuntimeFactory.lastRuntime!;
      const closeStarted = Promise.withResolvers<void>();
      const releaseClose = Promise.withResolvers<void>();
      runtime.closeImpl.mockImplementationOnce(async () => {
        closeStarted.resolve();
        await releaseClose.promise;
      });

      const stop = yield* adapter.stopSession(threadId).pipe(Effect.forkChild);
      yield* Effect.promise(() => closeStarted.promise);
      yield* Fiber.interrupt(stop);

      NodeAssert.equal(yield* adapter.hasSession(threadId), false);
      releaseClose.resolve();
    }),
  );

  it.effect("does not recreate a session when teardown lands during reconciliation close", () =>
    Effect.gen(function* () {
      reconciliationAvailability.generation = 60;
      reconciliationAvailability.available = false;
      reconciliationAvailability.advancesDuringPrepare = 0;
      reconciliationRuntimeFactory.factory.mockClear();
      const adapter = yield* CodexAdapter;
      const threadId = asThreadId("thread-stop-during-reconciliation-close");
      yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
      const runtime = reconciliationRuntimeFactory.lastRuntime!;
      const closeStarted = Promise.withResolvers<void>();
      const releaseClose = Promise.withResolvers<void>();
      runtime.closeImpl.mockImplementationOnce(async () => {
        closeStarted.resolve();
        await releaseClose.promise;
      });

      reconciliationAvailability.generation = 61;
      const send = yield* adapter
        .sendTurn({ threadId, input: "stale", attachments: [] })
        .pipe(Effect.forkChild);
      yield* Effect.promise(() => closeStarted.promise);
      yield* adapter.stopSession(threadId);
      releaseClose.resolve();

      const sendExit = yield* Fiber.await(send);
      NodeAssert.equal(Exit.isFailure(sendExit), true);
      if (Exit.isFailure(sendExit)) {
        NodeAssert.equal(Cause.hasInterruptsOnly(sendExit.cause), true);
      }
      NodeAssert.equal(reconciliationRuntimeFactory.factory.mock.calls.length, 2);
      yield* Effect.promise(() =>
        vi.waitFor(() =>
          NodeAssert.equal(
            reconciliationRuntimeFactory.lastRuntime?.closeImpl.mock.calls.length,
            1,
          ),
        ),
      );
      NodeAssert.equal(reconciliationRuntimeFactory.lastRuntime?.closeImpl.mock.calls.length, 1);
      NodeAssert.equal(yield* adapter.hasSession(threadId), false);
    }),
  );

  it.effect("removes a published replacement when its restart is interrupted", () =>
    Effect.gen(function* () {
      reconciliationAvailability.generation = 65;
      reconciliationAvailability.available = false;
      reconciliationAvailability.advancesDuringPrepare = 0;
      reconciliationRuntimeFactory.factory.mockClear();
      const adapter = yield* CodexAdapter;
      const threadId = asThreadId("thread-interrupt-replacement-close");
      yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
      const initialRuntime = reconciliationRuntimeFactory.lastRuntime!;
      const closeStarted = Promise.withResolvers<void>();
      const releaseClose = Promise.withResolvers<void>();
      const initialRuntimeClosed = Promise.withResolvers<void>();
      initialRuntime.closeImpl.mockImplementationOnce(async () => {
        closeStarted.resolve();
        await releaseClose.promise;
        initialRuntimeClosed.resolve();
      });

      const restart = yield* adapter
        .startSession({ threadId, runtimeMode: "full-access" })
        .pipe(Effect.forkChild);
      yield* Effect.promise(() => closeStarted.promise);
      const replacement = reconciliationRuntimeFactory.lastRuntime!;
      const replacementClosed = Promise.withResolvers<void>();
      replacement.closeImpl.mockImplementationOnce(async () => {
        replacementClosed.resolve();
        return undefined;
      });
      NodeAssert.equal(yield* adapter.hasSession(threadId), true);

      yield* Fiber.interrupt(restart);
      NodeAssert.equal(yield* adapter.hasSession(threadId), false);
      yield* Effect.promise(() => replacementClosed.promise);
      NodeAssert.equal(replacement.closeImpl.mock.calls.length, 1);
      releaseClose.resolve();
      yield* Effect.promise(() => initialRuntimeClosed.promise);
      NodeAssert.equal(yield* adapter.hasSession(threadId), false);
      NodeAssert.equal(replacement.closeImpl.mock.calls.length, 1);
    }),
  );

  it.effect("invalidates every queued send when a session is stopped", () =>
    Effect.gen(function* () {
      reconciliationAvailability.generation = 70;
      reconciliationAvailability.available = false;
      reconciliationAvailability.advancesDuringPrepare = 0;
      reconciliationRuntimeFactory.factory.mockClear();
      const adapter = yield* CodexAdapter;
      const threadId = asThreadId("thread-stop-with-queued-sends");
      yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
      const runtime = reconciliationRuntimeFactory.lastRuntime!;
      const readStarted = Promise.withResolvers<void>();
      const releaseRead = Promise.withResolvers<void>();
      runtime.onGetSession = async () => {
        runtime.onGetSession = undefined;
        readStarted.resolve();
        await releaseRead.promise;
      };

      const sends = yield* Effect.forEach(
        ["first", "second", "third"],
        (input) => adapter.sendTurn({ threadId, input, attachments: [] }).pipe(Effect.forkChild),
        { concurrency: 1 },
      );
      yield* Effect.promise(() => readStarted.promise);
      yield* adapter.stopSession(threadId);
      releaseRead.resolve();

      const exits = yield* Effect.forEach(sends, Fiber.await, { concurrency: "unbounded" });
      NodeAssert.equal(exits.every(Exit.isFailure), true);
      NodeAssert.equal(runtime.sendTurnImpl.mock.calls.length, 0);

      yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
      const replacement = reconciliationRuntimeFactory.lastRuntime!;
      yield* adapter.sendTurn({ threadId, input: "fresh", attachments: [] });
      NodeAssert.equal(replacement.sendTurnImpl.mock.calls.length, 1);
      NodeAssert.equal(replacement.closeImpl.mock.calls.length, 0);
    }),
  );

  it.effect("preserves the live session when automatic reconciliation cannot start", () =>
    Effect.gen(function* () {
      reconciliationAvailability.generation = 80;
      reconciliationAvailability.available = false;
      reconciliationAvailability.advancesDuringPrepare = 0;
      reconciliationRuntimeFactory.factory.mockClear();
      const adapter = yield* CodexAdapter;
      const threadId = asThreadId("thread-failed-integration-reconcile");
      yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
      const initialRuntime = reconciliationRuntimeFactory.lastRuntime!;

      reconciliationRuntimeFactory.factory.mockImplementationOnce((options) =>
        Effect.fail(
          new CodexErrors.CodexAppServerSpawnError({
            command: `${options.binaryPath} app-server`,
            cause: new Error("replacement construction failed"),
          }),
        ),
      );
      reconciliationAvailability.generation = 81;
      const failedSend = yield* adapter
        .sendTurn({ threadId, input: "retry plugin access", attachments: [] })
        .pipe(Effect.result);

      NodeAssert.equal(failedSend._tag, "Failure");
      NodeAssert.equal(yield* adapter.hasSession(threadId), true);
      NodeAssert.equal(initialRuntime.closeImpl.mock.calls.length, 0);

      yield* adapter.sendTurn({ threadId, input: "retry again", attachments: [] });
      NodeAssert.equal(initialRuntime.closeImpl.mock.calls.length, 1);
      NodeAssert.equal(reconciliationRuntimeFactory.lastRuntime?.sendTurnImpl.mock.calls.length, 1);
    }),
  );

  it.effect("recreates an idle session at its next turn boundary and preserves its model", () =>
    Effect.gen(function* () {
      reconciliationAvailability.generation = 0;
      reconciliationAvailability.available = false;
      reconciliationAvailability.advancesDuringPrepare = 0;
      reconciliationRuntimeFactory.factory.mockClear();
      const adapter = yield* CodexAdapter;
      const threadId = asThreadId("thread-integration-reconcile");
      yield* adapter.startSession({
        threadId,
        runtimeMode: "full-access",
        modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "gpt-start", [
          { id: "reasoningEffort", value: "low" },
        ]),
      });
      const latestModelSelection = createModelSelection(
        ProviderInstanceId.make("codex"),
        "gpt-current",
        [
          { id: "reasoningEffort", value: "high" },
          { id: "serviceTier", value: "priority" },
        ],
      );
      yield* adapter.sendTurn({
        threadId,
        input: "switch model",
        attachments: [],
        modelSelection: latestModelSelection,
      });

      reconciliationAvailability.available = true;
      reconciliationAvailability.generation = 1;
      yield* adapter.sendTurn({ threadId, input: "use the plugin", attachments: [] });

      NodeAssert.equal(reconciliationRuntimeFactory.factory.mock.calls.length, 2);
      const reconciledOptions = reconciliationRuntimeFactory.lastRuntime?.options;
      NodeAssert.equal(reconciledOptions?.model, "gpt-current");
      NodeAssert.equal(reconciledOptions?.serviceTier, "priority");
      NodeAssert.equal(reconciledOptions?.resumeCursor?.threadId, "provider-thread-1");
      NodeAssert.deepStrictEqual(
        reconciledOptions?.dynamicTools?.map(({ name }) => name),
        [
          TRITONAI_COMMONS_SUBMIT_TOOL_NAME,
          codexDynamicIntegrationToolName(reconciliationToolName),
        ],
      );
    }),
  );

  it.effect("does not interrupt an active turn and keeps revoked dynamic tools fail closed", () =>
    Effect.gen(function* () {
      reconciliationAvailability.generation = 2;
      reconciliationAvailability.available = true;
      reconciliationAvailability.advancesDuringPrepare = 0;
      reconciliationRuntimeFactory.factory.mockClear();
      const adapter = yield* CodexAdapter;
      const threadId = asThreadId("thread-integration-active-revocation");
      yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
      const activeRuntime = reconciliationRuntimeFactory.lastRuntime!;
      activeRuntime.sessionStatus = "running";
      activeRuntime.activeTurnId = asTurnId("turn-active");

      reconciliationAvailability.available = false;
      reconciliationAvailability.generation = 3;
      const binding = activeRuntime.options.dynamicTools?.find(
        ({ name }) => name === codexDynamicIntegrationToolName(reconciliationToolName),
      );
      NodeAssert.equal(activeRuntime.options.isDynamicToolAvailable?.(binding!.name), false);
      yield* Effect.promise(() =>
        NodeAssert.rejects(() =>
          activeRuntime.options.invokeDynamicTool!({
            name: binding!.name,
            arguments: {},
            signal: new AbortController().signal,
          }),
        ),
      );
      yield* adapter.sendTurn({ threadId, input: "active turn boundary", attachments: [] });

      NodeAssert.equal(reconciliationRuntimeFactory.factory.mock.calls.length, 1);
      NodeAssert.equal(activeRuntime.closeImpl.mock.calls.length, 0);
    }),
  );
});

const sessionRuntimeFactory = makeRuntimeFactory();
const sessionErrorLayer = it.layer(
  Layer.effect(
    CodexAdapter,
    Effect.gen(function* () {
      const codexConfig = decodeCodexSettings({});
      return yield* makeCodexAdapter(codexConfig, {
        makeRuntime: sessionRuntimeFactory.factory,
      });
    }),
  ).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(providerSessionDirectoryTestLayer),
    Layer.provideMerge(NodeServices.layer),
  ),
);

sessionErrorLayer("CodexAdapterLive session errors", (it) => {
  it.effect("maps missing adapter sessions to ProviderAdapterSessionNotFoundError", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const result = yield* adapter
        .sendTurn({
          threadId: asThreadId("sess-missing"),
          input: "hello",
          attachments: [],
        })
        .pipe(Effect.result);

      NodeAssert.equal(result._tag, "Failure");
      NodeAssert.equal(result.failure._tag, "ProviderAdapterSessionNotFoundError");
      NodeAssert.equal(result.failure.provider, "codex");
      NodeAssert.equal(result.failure.threadId, "sess-missing");
    }),
  );

  it.effect("compacts the active Codex thread and emits compacted state", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const threadId = asThreadId("thread-compact");
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("codex"),
        threadId,
        runtimeMode: "full-access",
      });
      const runtime = sessionRuntimeFactory.lastRuntime;
      NodeAssert.ok(runtime);
      const compactedEventFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.type === "thread.state.changed"),
        Stream.runHead,
        Effect.forkChild,
      );
      NodeAssert.ok(adapter.compaction?.type === "native");
      yield* adapter.compaction.start(threadId);
      yield* runtime.emit({
        id: asEventId("evt-compaction-item-completed"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "item/completed",
        threadId,
        payload: {
          completedAtMs: 1_778_000_000_000,
          threadId: "provider-thread-1",
          turnId: "provider-compact-turn",
          item: {
            id: "provider-compact-item",
            type: "contextCompaction",
          },
        },
      });
      const event = Option.getOrThrow(yield* Fiber.join(compactedEventFiber));
      NodeAssert.ok(event.type === "thread.state.changed");
      NodeAssert.equal(event.payload.state, "compacted");
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("uploads feedback for the active Codex thread", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const threadId = asThreadId("thread-feedback");
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("codex"),
        threadId,
        runtimeMode: "full-access",
      });
      const runtime = sessionRuntimeFactory.lastRuntime;
      NodeAssert.ok(runtime);

      const result = yield* adapter.uploadFeedback({
        threadId,
        reason: "The agent stopped early.",
      });

      NodeAssert.deepStrictEqual(result, { feedbackId: "provider-thread-1" });
      NodeAssert.deepStrictEqual(runtime.uploadFeedbackImpl.mock.calls, [
        ["The agent stopped early."],
      ]);
    }),
  );

  it.effect("rejects feedback for an unknown Codex thread", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const result = yield* adapter
        .uploadFeedback({ threadId: asThreadId("thread-feedback-missing") })
        .pipe(Effect.result);

      NodeAssert.equal(result._tag, "Failure");
      NodeAssert.equal(result.failure._tag, "ProviderAdapterSessionNotFoundError");
    }),
  );

  it.effect("maps codex model options before sending a turn", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("sess-missing"),
        runtimeMode: "full-access",
      });
      const runtime = sessionRuntimeFactory.lastRuntime;
      NodeAssert.ok(runtime);
      runtime.sendTurnImpl.mockClear();

      yield* Effect.ignore(
        adapter.sendTurn({
          threadId: asThreadId("sess-missing"),
          input: "hello",
          modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.3-codex", [
            { id: "reasoningEffort", value: "high" },
            { id: "serviceTier", value: "priority" },
          ]),
          attachments: [],
        }),
      );

      NodeAssert.deepStrictEqual(runtime.sendTurnImpl.mock.calls[0]?.[0], {
        input: "hello",
        model: "gpt-5.3-codex",
        effort: "high",
        serviceTier: "priority",
      });
    }),
  );

  it.effect("passes configured launch args into the session runtime", () => {
    const runtimeFactory = makeRuntimeFactory();
    const layer = Layer.effect(
      CodexAdapter,
      Effect.gen(function* () {
        const codexConfig = decodeCodexSettings({ launchArgs: "--strict-config --enable foo" });
        return yield* makeCodexAdapter(codexConfig, {
          makeRuntime: runtimeFactory.factory,
        });
      }),
    ).pipe(
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(providerSessionDirectoryTestLayer),
      Layer.provideMerge(NodeServices.layer),
    );

    return Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("sess-launch-args"),
        runtimeMode: "full-access",
      });

      const runtime = runtimeFactory.lastRuntime;
      NodeAssert.ok(runtime);
      NodeAssert.equal(runtime.options.launchArgs, "--strict-config --enable foo");
    }).pipe(Effect.provide(layer));
  });

  it.effect("uses T3CODE_CODEX_LAUNCH_ARGS for the session runtime", () => {
    const runtimeFactory = makeRuntimeFactory();
    const layer = Layer.effect(
      CodexAdapter,
      Effect.gen(function* () {
        const codexConfig = decodeCodexSettings({ launchArgs: "--enable settings-feature" });
        return yield* makeCodexAdapter(codexConfig, {
          environment: { T3CODE_CODEX_LAUNCH_ARGS: " --strict-config --enable env-feature " },
          makeRuntime: runtimeFactory.factory,
        });
      }),
    ).pipe(
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(providerSessionDirectoryTestLayer),
      Layer.provideMerge(NodeServices.layer),
    );

    return Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("sess-launch-args-env"),
        runtimeMode: "full-access",
      });

      const runtime = runtimeFactory.lastRuntime;
      NodeAssert.ok(runtime);
      NodeAssert.equal(runtime.options.launchArgs, "--strict-config --enable env-feature");
    }).pipe(Effect.provide(layer));
  });

  it.effect("maps codex model options for the adapter's bound custom instance id", () => {
    const customInstanceId = ProviderInstanceId.make("codex_personal");
    const customRuntimeFactory = makeRuntimeFactory();
    const customLayer = Layer.effect(
      CodexAdapter,
      Effect.gen(function* () {
        const codexConfig = decodeCodexSettings({});
        return yield* makeCodexAdapter(codexConfig, {
          instanceId: customInstanceId,
          makeRuntime: customRuntimeFactory.factory,
        });
      }),
    ).pipe(
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(providerSessionDirectoryTestLayer),
      Layer.provideMerge(NodeServices.layer),
    );

    return Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("sess-custom-instance"),
        runtimeMode: "full-access",
      });
      const runtime = customRuntimeFactory.lastRuntime;
      NodeAssert.ok(runtime);
      runtime.sendTurnImpl.mockClear();

      yield* Effect.ignore(
        adapter.sendTurn({
          threadId: asThreadId("sess-custom-instance"),
          input: "hello",
          modelSelection: createModelSelection(
            ProviderInstanceId.make("codex_personal"),
            "gpt-5.3-codex",
            [
              { id: "reasoningEffort", value: "high" },
              { id: "serviceTier", value: "flex" },
            ],
          ),
          attachments: [],
        }),
      );

      NodeAssert.deepStrictEqual(runtime.sendTurnImpl.mock.calls[0]?.[0], {
        input: "hello",
        model: "gpt-5.3-codex",
        effort: "high",
        serviceTier: "flex",
      });
    }).pipe(Effect.provide(customLayer));
  });

  it.effect("passes the managed model catalog to Codex app-server", () => {
    const runtimeFactory = makeRuntimeFactory();
    const layer = Layer.effect(
      CodexAdapter,
      Effect.gen(function* () {
        const codexConfig = decodeCodexSettings({});
        return yield* makeCodexAdapter(codexConfig, {
          makeRuntime: runtimeFactory.factory,
          modelCatalogPath: "/managed home/tritonai-model-catalog.json",
        });
      }),
    ).pipe(
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(providerSessionDirectoryTestLayer),
      Layer.provideMerge(NodeServices.layer),
    );

    return Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("managed-model-catalog"),
        runtimeMode: "full-access",
      });

      NodeAssert.deepStrictEqual(runtimeFactory.lastRuntime?.options.appServerArgs, [
        "-c",
        'model_catalog_json="/managed home/tritonai-model-catalog.json"',
      ]);
    }).pipe(Effect.provide(layer));
  });
});

const lifecycleRuntimeFactory = makeRuntimeFactory();
const lifecycleLayer = it.layer(
  Layer.effect(
    CodexAdapter,
    Effect.gen(function* () {
      const codexConfig = decodeCodexSettings({});
      return yield* makeCodexAdapter(codexConfig, {
        makeRuntime: lifecycleRuntimeFactory.factory,
      });
    }),
  ).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(providerSessionDirectoryTestLayer),
    Layer.provideMerge(NodeServices.layer),
  ),
);

function startLifecycleRuntime(configureRuntime?: (runtime: FakeCodexRuntime) => void) {
  return Effect.gen(function* () {
    const adapter = yield* CodexAdapter;
    if (configureRuntime) {
      lifecycleRuntimeFactory.configureNextRuntime(configureRuntime);
    }
    yield* adapter.startSession({
      provider: ProviderDriverKind.make("codex"),
      threadId: asThreadId("thread-1"),
      runtimeMode: "full-access",
    });
    const runtime = lifecycleRuntimeFactory.lastRuntime;
    NodeAssert.ok(runtime);
    return { adapter, runtime };
  });
}

function codexTokenUsageEvent(input: {
  readonly id: string;
  readonly turnId: string;
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheCreationTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
  readonly last?: {
    readonly inputTokens: number;
    readonly cachedInputTokens: number;
    readonly cacheCreationTokens: number;
    readonly outputTokens: number;
    readonly reasoningTokens: number;
  };
}): ProviderEvent {
  const totalTokens = input.inputTokens + input.outputTokens;
  const last = input.last ?? input;
  return {
    id: asEventId(input.id),
    kind: "notification",
    provider: ProviderDriverKind.make("codex"),
    threadId: asThreadId("thread-1"),
    turnId: asTurnId(input.turnId),
    createdAt: "2026-01-01T00:00:00.000Z",
    method: "thread/tokenUsage/updated",
    payload: {
      threadId: "thread-1",
      turnId: input.turnId,
      tokenUsage: {
        total: {
          inputTokens: input.inputTokens,
          cachedInputTokens: input.cachedInputTokens,
          cacheWriteInputTokens: input.cacheCreationTokens,
          outputTokens: input.outputTokens,
          reasoningOutputTokens: input.reasoningTokens,
          totalTokens,
        },
        last: {
          inputTokens: last.inputTokens,
          cachedInputTokens: last.cachedInputTokens,
          cacheWriteInputTokens: last.cacheCreationTokens,
          outputTokens: last.outputTokens,
          reasoningOutputTokens: last.reasoningTokens,
          totalTokens: last.inputTokens + last.outputTokens,
        },
      },
    },
  };
}

function codexTurnEvent(method: "turn/started" | "turn/completed", turnId: string): ProviderEvent {
  return {
    id: asEventId(`evt-${method}-${turnId}`),
    kind: "notification",
    provider: ProviderDriverKind.make("codex"),
    threadId: asThreadId("thread-1"),
    turnId: asTurnId(turnId),
    createdAt: "2026-01-01T00:00:00.000Z",
    method,
    payload:
      method === "turn/started"
        ? {}
        : {
            threadId: "thread-1",
            turn: { id: turnId, items: [], status: "completed" },
          },
  };
}

lifecycleLayer("CodexAdapterLive lifecycle", (it) => {
  it.effect("shows legacy agent prompts, results, and successful closure", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const collected = yield* adapter.streamEvents.pipe(
        Stream.take(3),
        Stream.runCollect,
        Effect.forkChild,
      );
      for (const [method, payload] of [
        ["collabAgent/started", { description: "Check the task queue" }],
        ["collabAgent/item", { item: { type: "agentMessage", text: "ALPHA" } }],
        ["collabAgent/closed", { status: "completed" }],
      ] as const) {
        yield* runtime.emit({
          id: asEventId(method),
          kind: "notification",
          provider: ProviderDriverKind.make("codex"),
          createdAt: "2026-01-01T00:00:00.000Z",
          method,
          threadId: asThreadId("thread-1"),
          payload: { agentThreadId: "legacy-child", nickname: "Euclid", ...payload },
        });
      }
      const events = Array.from(yield* Fiber.join(collected));
      NodeAssert.equal(events[0]?.type, "task.started");
      NodeAssert.equal(
        (events[0]?.payload as { description?: string }).description,
        "Check the task queue",
      );
      NodeAssert.equal((events[1]?.payload as { summary?: string }).summary, "ALPHA");
      NodeAssert.equal((events[2]?.payload as { status?: string }).status, "completed");
    }),
  );

  it.effect("calculates one Codex turn total from cumulative counters", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const completedFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.type === "turn.completed"),
        Stream.runHead,
        Effect.forkChild,
      );

      yield* runtime.emit(codexTurnEvent("turn/started", "turn-usage"));
      yield* runtime.emit(
        codexTokenUsageEvent({
          id: "evt-usage-1",
          turnId: "turn-usage",
          inputTokens: 100,
          cachedInputTokens: 40,
          cacheCreationTokens: 10,
          outputTokens: 20,
          reasoningTokens: 8,
        }),
      );
      // Codex can repeat both notifications without new work.
      yield* runtime.emit(codexTurnEvent("turn/started", "turn-usage"));
      yield* runtime.emit(
        codexTokenUsageEvent({
          id: "evt-usage-duplicate",
          turnId: "turn-usage",
          inputTokens: 100,
          cachedInputTokens: 40,
          cacheCreationTokens: 10,
          outputTokens: 20,
          reasoningTokens: 8,
        }),
      );
      yield* runtime.emit({
        id: asEventId("evt-collab-activity"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-usage"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "collabAgent/activity",
        payload: {
          agentThreadId: "child-1",
          agentPath: "/root/child-1",
          activityKind: "started",
        },
      });
      yield* runtime.emit(
        codexTokenUsageEvent({
          id: "evt-usage-2",
          turnId: "turn-usage",
          inputTokens: 150,
          cachedInputTokens: 60,
          cacheCreationTokens: 15,
          outputTokens: 30,
          reasoningTokens: 12,
        }),
      );
      yield* runtime.emit(codexTurnEvent("turn/completed", "turn-usage"));

      const completed = yield* Fiber.join(completedFiber);
      NodeAssert.equal(completed._tag, "Some");
      if (completed._tag === "Some" && completed.value.type === "turn.completed") {
        NodeAssert.deepStrictEqual(completed.value.payload.tokenUsage, {
          usageStatus: "complete",
          usageScope: "main_agent",
          inputTokens: 150,
          cachedInputTokens: 60,
          cacheCreationTokens: 15,
          outputTokens: 30,
          reasoningTokens: 12,
          hasSubagents: true,
        });
      }
    }),
  );

  it.effect("does not charge a late prior-turn update to the next Codex turn", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const completedFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.type === "turn.completed"),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* runtime.emit(codexTurnEvent("turn/started", "turn-first"));
      yield* runtime.emit(
        codexTokenUsageEvent({
          id: "evt-late-1",
          turnId: "turn-first",
          inputTokens: 100,
          cachedInputTokens: 40,
          cacheCreationTokens: 10,
          outputTokens: 20,
          reasoningTokens: 8,
        }),
      );
      yield* runtime.emit(codexTurnEvent("turn/completed", "turn-first"));
      yield* runtime.emit(codexTurnEvent("turn/started", "turn-second"));
      // A late update for the finished turn lands after the next turn starts.
      yield* runtime.emit(
        codexTokenUsageEvent({
          id: "evt-late-2",
          turnId: "turn-first",
          inputTokens: 150,
          cachedInputTokens: 60,
          cacheCreationTokens: 15,
          outputTokens: 30,
          reasoningTokens: 12,
        }),
      );
      yield* runtime.emit(
        codexTokenUsageEvent({
          id: "evt-late-3",
          turnId: "turn-second",
          inputTokens: 170,
          cachedInputTokens: 65,
          cacheCreationTokens: 16,
          outputTokens: 35,
          reasoningTokens: 14,
        }),
      );
      yield* runtime.emit(codexTurnEvent("turn/completed", "turn-second"));

      const completed = Array.from(yield* Fiber.join(completedFiber));
      const second = completed[1];
      NodeAssert.equal(second?.type, "turn.completed");
      if (second?.type === "turn.completed") {
        NodeAssert.deepStrictEqual(second.payload.tokenUsage, {
          usageStatus: "complete",
          usageScope: "main_agent",
          inputTokens: 20,
          cachedInputTokens: 5,
          cacheCreationTokens: 1,
          outputTokens: 5,
          reasoningTokens: 2,
          hasSubagents: false,
        });
      }
    }),
  );

  it.effect("clamps Codex cache and reasoning subsets to their totals", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const completedFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.type === "turn.completed"),
        Stream.runHead,
        Effect.forkChild,
      );

      yield* runtime.emit(codexTurnEvent("turn/started", "turn-clamp"));
      yield* runtime.emit(
        codexTokenUsageEvent({
          id: "evt-clamp-1",
          turnId: "turn-clamp",
          inputTokens: 100,
          cachedInputTokens: 140,
          cacheCreationTokens: 120,
          outputTokens: 20,
          reasoningTokens: 30,
        }),
      );
      yield* runtime.emit(codexTurnEvent("turn/completed", "turn-clamp"));

      const completed = yield* Fiber.join(completedFiber);
      NodeAssert.equal(completed._tag, "Some");
      if (completed._tag === "Some" && completed.value.type === "turn.completed") {
        NodeAssert.deepStrictEqual(completed.value.payload.tokenUsage, {
          usageStatus: "complete",
          usageScope: "main_agent",
          inputTokens: 100,
          cachedInputTokens: 100,
          cacheCreationTokens: 100,
          outputTokens: 20,
          reasoningTokens: 20,
          hasSubagents: false,
        });
      }
    }),
  );

  it.effect("counts the last response when Codex resets its running total mid-turn", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const completedFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.type === "turn.completed"),
        Stream.runHead,
        Effect.forkChild,
      );

      yield* runtime.emit(codexTurnEvent("turn/started", "turn-reset"));
      yield* runtime.emit(
        codexTokenUsageEvent({
          id: "evt-reset-1",
          turnId: "turn-reset",
          inputTokens: 5_000,
          cachedInputTokens: 4_000,
          cacheCreationTokens: 100,
          outputTokens: 500,
          reasoningTokens: 200,
          last: {
            inputTokens: 100,
            cachedInputTokens: 80,
            cacheCreationTokens: 10,
            outputTokens: 20,
            reasoningTokens: 8,
          },
        }),
      );
      // Codex restarted its cumulative total. The new total is smaller than
      // the previous one, so only `last` is counted for this update.
      yield* runtime.emit(
        codexTokenUsageEvent({
          id: "evt-reset-2",
          turnId: "turn-reset",
          inputTokens: 150,
          cachedInputTokens: 90,
          cacheCreationTokens: 5,
          outputTokens: 30,
          reasoningTokens: 12,
        }),
      );
      yield* runtime.emit(codexTurnEvent("turn/completed", "turn-reset"));

      const completed = yield* Fiber.join(completedFiber);
      NodeAssert.equal(completed._tag, "Some");
      if (completed._tag === "Some" && completed.value.type === "turn.completed") {
        NodeAssert.deepStrictEqual(completed.value.payload.tokenUsage, {
          usageStatus: "complete",
          usageScope: "main_agent",
          inputTokens: 250,
          cachedInputTokens: 170,
          cacheCreationTokens: 15,
          outputTokens: 50,
          reasoningTokens: 20,
          hasSubagents: false,
        });
      }
    }),
  );

  it.effect("uses the last response usage when no prior Codex total exists", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        resumeCursor: { threadId: "provider-thread-1" },
        runtimeMode: "full-access",
      });
      const runtime = lifecycleRuntimeFactory.lastRuntime;
      NodeAssert.ok(runtime);
      const firstCompletionsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.type === "turn.completed"),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild,
      );

      // Resumed thread: the cumulative total already holds old history, so the
      // first update must count only `last`.
      yield* runtime.emit(codexTurnEvent("turn/started", "turn-resumed"));
      yield* runtime.emit(
        codexTokenUsageEvent({
          id: "evt-resume-baseline",
          turnId: "turn-resumed",
          inputTokens: 1_000,
          cachedInputTokens: 400,
          cacheCreationTokens: 100,
          outputTokens: 200,
          reasoningTokens: 80,
          last: {
            inputTokens: 300,
            cachedInputTokens: 120,
            cacheCreationTokens: 30,
            outputTokens: 60,
            reasoningTokens: 24,
          },
        }),
      );
      yield* runtime.emit(codexTurnEvent("turn/completed", "turn-resumed"));

      yield* runtime.emit(codexTurnEvent("turn/started", "turn-after-resume"));
      yield* runtime.emit(
        codexTokenUsageEvent({
          id: "evt-after-resume",
          turnId: "turn-after-resume",
          inputTokens: 1_100,
          cachedInputTokens: 440,
          cacheCreationTokens: 110,
          outputTokens: 220,
          reasoningTokens: 88,
        }),
      );
      yield* runtime.emit(codexTurnEvent("turn/completed", "turn-after-resume"));

      const firstCompletions = Array.from(yield* Fiber.join(firstCompletionsFiber));

      yield* adapter.rollbackThread(asThreadId("thread-1"), 1);
      const rollbackCompletionFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.type === "turn.completed"),
        Stream.runHead,
        Effect.forkChild,
      );
      // Rollback drops the baseline and Codex shrinks its total, so the first
      // update after it counts only `last` again.
      yield* runtime.emit(codexTurnEvent("turn/started", "turn-after-rollback"));
      yield* runtime.emit(
        codexTokenUsageEvent({
          id: "evt-after-rollback",
          turnId: "turn-after-rollback",
          inputTokens: 1_050,
          cachedInputTokens: 420,
          cacheCreationTokens: 105,
          outputTokens: 210,
          reasoningTokens: 84,
          last: {
            inputTokens: 50,
            cachedInputTokens: 20,
            cacheCreationTokens: 5,
            outputTokens: 10,
            reasoningTokens: 4,
          },
        }),
      );
      yield* runtime.emit(codexTurnEvent("turn/completed", "turn-after-rollback"));

      const rollbackCompletion = yield* Fiber.join(rollbackCompletionFiber);
      const completions = [
        ...firstCompletions,
        ...(rollbackCompletion._tag === "Some" ? [rollbackCompletion.value] : []),
      ];
      NodeAssert.deepStrictEqual(
        completions.map((event) =>
          event.type === "turn.completed" ? event.payload.tokenUsage : undefined,
        ),
        [
          {
            usageStatus: "complete",
            usageScope: "main_agent",
            inputTokens: 300,
            cachedInputTokens: 120,
            cacheCreationTokens: 30,
            outputTokens: 60,
            reasoningTokens: 24,
            hasSubagents: false,
          },
          {
            usageStatus: "complete",
            usageScope: "main_agent",
            inputTokens: 100,
            cachedInputTokens: 40,
            cacheCreationTokens: 10,
            outputTokens: 20,
            reasoningTokens: 8,
            hasSubagents: false,
          },
          {
            usageStatus: "complete",
            usageScope: "main_agent",
            inputTokens: 50,
            cachedInputTokens: 20,
            cacheCreationTokens: 5,
            outputTokens: 10,
            reasoningTokens: 4,
            hasSubagents: false,
          },
        ],
      );
    }),
  );

  it.effect("carries child model metadata through every task event", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 10)).pipe(
        Effect.forkChild,
      );

      const cases = [
        ["collabAgent/started", {}],
        ["collabAgent/activity", { activityKind: "started" }],
        ["collabAgent/turnStarted", {}],
        ["collabAgent/turnCompleted", { turn: { status: "completed" } }],
        ["collabAgent/statusChanged", { status: { type: "active", activeFlags: [] } }],
        ["collabAgent/tokenUsage", { tokenUsage: { total: { totalTokens: 42 } } }],
        ["collabAgent/item", { item: { type: "commandExecution", command: "pwd" } }],
        ["collabAgent/closed", {}],
        ["collabAgent/metadataUpdated", {}],
      ] as const;

      for (const [index, [method, extra]] of cases.entries()) {
        yield* runtime.emit({
          id: asEventId(`evt-child-model-${index}`),
          kind: "notification",
          provider: ProviderDriverKind.make("codex"),
          createdAt: "2026-01-01T00:00:00.000Z",
          method,
          threadId: asThreadId("thread-1"),
          turnId: asTurnId("turn-1"),
          payload: {
            agentThreadId: "child-model",
            agentPath: "/root/model-check",
            model: " gpt-5.6-sol ",
            effort: " high ",
            ...extra,
          },
        });
      }
      yield* runtime.emit({
        id: asEventId("evt-child-model-blank"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "collabAgent/metadataUpdated",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        payload: {
          agentThreadId: "child-model",
          model: "  ",
          effort: "",
        },
      });

      const events = Array.from(yield* Fiber.join(eventsFiber));
      NodeAssert.deepStrictEqual(
        events.map((event) => event.type),
        [
          "task.started",
          "task.started",
          "task.updated",
          "task.updated",
          "task.updated",
          "task.progress",
          "task.progress",
          "task.updated",
          "task.updated",
          "task.updated",
        ],
      );
      for (const event of events.slice(0, -1)) {
        const payload = event.payload as Record<string, unknown>;
        NodeAssert.equal(payload.model, "gpt-5.6-sol");
        NodeAssert.equal(payload.effort, "high");
      }

      const metadataPayload = events[8]?.payload as Record<string, unknown>;
      NodeAssert.equal("status" in metadataPayload, false);
      const blankMetadataPayload = events[9]?.payload as Record<string, unknown>;
      NodeAssert.equal("status" in blankMetadataPayload, false);
      NodeAssert.equal("model" in blankMetadataPayload, false);
      NodeAssert.equal("effort" in blankMetadataPayload, false);
    }),
  );

  it.effect("does not reactivate an idle child after a parent interaction", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 3)).pipe(
        Effect.forkChild,
      );

      const childEvent = (id: string, method: string, payload: Record<string, unknown>) => ({
        id: asEventId(id),
        kind: "notification" as const,
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method,
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        payload,
      });

      yield* runtime.emit(
        childEvent("evt-child-running", "collabAgent/turnStarted", {
          agentThreadId: "child-1",
          agentPath: "/root/audit",
        }),
      );
      yield* runtime.emit(
        childEvent("evt-child-idle", "collabAgent/turnCompleted", {
          agentThreadId: "child-1",
          agentPath: "/root/audit",
          turn: { status: "completed" },
        }),
      );
      yield* runtime.emit(
        childEvent("evt-child-interacted", "collabAgent/activity", {
          agentThreadId: "child-1",
          agentPath: "/root/audit",
          activityKind: "interacted",
        }),
      );
      yield* runtime.emit(
        childEvent("evt-other-child-running", "collabAgent/turnStarted", {
          agentThreadId: "child-2",
          agentPath: "/root/other",
        }),
      );

      const events = Array.from(yield* Fiber.join(eventsFiber));
      NodeAssert.deepStrictEqual(
        events.map((event) =>
          event.type === "task.updated"
            ? { taskId: event.payload.taskId, status: event.payload.status }
            : { type: event.type },
        ),
        [
          { taskId: "child-1", status: "running" },
          { taskId: "child-1", status: "idle" },
          { taskId: "child-2", status: "running" },
        ],
      );
    }),
  );

  it.effect("maps completed agent message items to canonical item.completed events", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      const event: ProviderEvent = {
        id: asEventId("evt-msg-complete"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "item/completed",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        itemId: asItemId("msg_1"),
        payload: {
          completedAtMs: 1_778_000_000_000,
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "agentMessage",
            id: "msg_1",
            text: "done",
          },
        },
      };

      yield* runtime.emit(event);
      const firstEvent = yield* Fiber.join(firstEventFiber);

      NodeAssert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      NodeAssert.equal(firstEvent.value.type, "item.completed");
      if (firstEvent.value.type !== "item.completed") {
        return;
      }
      NodeAssert.equal(firstEvent.value.itemId, "msg_1");
      NodeAssert.equal(firstEvent.value.turnId, "turn-1");
      NodeAssert.equal(firstEvent.value.payload.itemType, "assistant_message");
    }),
  );

  it.effect("labels MCP lifecycle entries with server and tool names", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      yield* runtime.emit({
        id: asEventId("evt-mcp-complete"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "item/completed",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        itemId: asItemId("mcp_1"),
        payload: {
          completedAtMs: 1_778_000_000_000,
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "mcpToolCall",
            id: "mcp_1",
            server: "t3-code",
            tool: "preview_status",
            arguments: {},
            durationMs: 12,
            error: null,
            result: { content: [{ type: "text", text: "attached" }] },
            status: "completed",
          },
        },
      });
      const firstEvent = yield* Fiber.join(firstEventFiber);

      NodeAssert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some" || firstEvent.value.type !== "item.completed") {
        return;
      }
      NodeAssert.equal(firstEvent.value.payload.itemType, "mcp_tool_call");
      NodeAssert.equal(firstEvent.value.payload.title, "t3-code · preview_status");
      NodeAssert.deepStrictEqual(firstEvent.value.payload.data, {
        completedAtMs: 1_778_000_000_000,
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "mcpToolCall",
          id: "mcp_1",
          server: "t3-code",
          tool: "preview_status",
          arguments: {},
          durationMs: 12,
          error: null,
          result: { content: [{ type: "text", text: "attached" }] },
          status: "completed",
        },
      });
    }),
  );

  it.effect("presents browser and computer-use calls with Codex-style titles and sources", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 3)).pipe(
        Effect.forkChild,
      );
      const longIntentTitle = `  ${"a".repeat(39)}   ${"a".repeat(38)}😀bc  `;
      const serializedOverContractUrl = `https://example.com/?query=${"😀".repeat(400)}`;

      yield* runtime.emit({
        id: asEventId("evt-computer-start"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "item/started",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        itemId: asItemId("computer_1"),
        payload: {
          startedAtMs: 1_778_000_000_000,
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "mcpToolCall",
            id: "computer_1",
            server: "node_repl",
            tool: "js",
            arguments: {
              code: 'await sky.click({ app: "Finder", x: 10, y: 20 })',
              title: longIntentTitle,
            },
            durationMs: null,
            error: null,
            result: {
              _meta: {
                "codex/toolSurface": {
                  kind: "computerUse",
                  app: { kind: "appId", appId: "com.apple.finder" },
                },
              },
              content: [],
            },
            status: "inProgress",
          },
        },
      });
      yield* runtime.emit({
        id: asEventId("evt-browser-complete"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:01.000Z",
        method: "item/completed",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        itemId: asItemId("browser_1"),
        payload: {
          completedAtMs: 1_778_000_001_000,
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "mcpToolCall",
            id: "browser_1",
            server: "node_repl",
            tool: "js",
            arguments: { code: "await tab.playwright.domSnapshot()", title: "Inspect checkout" },
            durationMs: 12,
            error: null,
            result: {
              _meta: {
                "codex/toolSurface": {
                  kind: "browserUse",
                  backend: "chrome",
                  openTabs: [
                    {
                      pageUrl: "https://www.mathworks.com/help/matlab/",
                      faviconUrl: "https://www.mathworks.com/favicon.ico",
                      faviconUrlDark: "https://www.mathworks.com/favicon-dark.ico",
                      url: "https://www.mathworks.com/help/matlab/",
                    },
                  ],
                },
                browser_use: { url: serializedOverContractUrl },
              },
              content: [],
            },
            status: "completed",
          },
        },
      });
      yield* runtime.emit({
        id: asEventId("evt-computer-use-complete"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:02.000Z",
        method: "item/completed",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        itemId: asItemId("computer_2"),
        payload: {
          completedAtMs: 1_778_000_002_000,
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "mcpToolCall",
            id: "computer_2",
            server: "computer-use",
            tool: "type_text",
            arguments: { text: "Hello world", app: "TextEdit" },
            durationMs: 12,
            error: null,
            result: {
              _meta: {
                "codex/toolSurface": {
                  kind: "computerUse",
                  app: { kind: "displayName", displayName: "TextEdit" },
                },
              },
              content: [],
            },
            status: "completed",
          },
        },
      });

      const events = Array.from(yield* Fiber.join(eventsFiber));
      NodeAssert.deepStrictEqual(
        events.map((event) => ({
          type: event.type,
          title: "title" in event.payload ? event.payload.title : undefined,
          toolSurface: "toolSurface" in event.payload ? event.payload.toolSurface : undefined,
          toolIcon: "toolIcon" in event.payload ? event.payload.toolIcon : undefined,
          toolSource: "toolSource" in event.payload ? event.payload.toolSource : undefined,
        })),
        [
          {
            type: "item.started",
            title: `${"a".repeat(39)} ${"a".repeat(38)}😀…`,
            toolSurface: "computer",
            toolIcon: {
              _tag: "native-app",
              app: { _tag: "app-id", appId: "com.apple.finder" },
            },
            toolSource: {
              key: "native-app:com.apple.finder",
              name: "Finder",
              kind: "computer",
              icon: {
                _tag: "native-app",
                app: { _tag: "app-id", appId: "com.apple.finder" },
              },
            },
          },
          {
            type: "item.completed",
            title: "Inspect checkout",
            toolSurface: "browser",
            toolIcon: {
              _tag: "website",
              pageUrl: "https://www.mathworks.com/help/matlab/",
              faviconUrl: "https://www.mathworks.com/favicon.ico",
              faviconUrlDark: "https://www.mathworks.com/favicon-dark.ico",
            },
            toolSource: {
              key: "browser-use:chrome",
              name: "Chrome",
              kind: "integration",
              icon: {
                _tag: "native-app",
                app: { _tag: "display-name", displayName: "Google Chrome" },
              },
            },
          },
          {
            type: "item.completed",
            title: "Typed text in TextEdit",
            toolSurface: "computer",
            toolIcon: {
              _tag: "native-app",
              app: { _tag: "display-name", displayName: "TextEdit" },
            },
            toolSource: {
              key: "native-app-name:textedit",
              name: "TextEdit",
              kind: "computer",
              icon: {
                _tag: "native-app",
                app: { _tag: "display-name", displayName: "TextEdit" },
              },
            },
          },
        ],
      );
    }),
  );

  it.effect("preserves failed and declined outcomes on completed tool items", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const maxLengthAppId = `com.${"a".repeat(508)}`;
      const collidingMaxLengthAppId = `com.${"a".repeat(507)}b`;
      const longAppSourceKeys: string[] = [];
      const items = [
        {
          type: "commandExecution",
          id: "failed-command",
          command: "vp test run",
          commandActions: [],
          cwd: "/tmp",
          exitCode: 1,
          status: "failed",
        },
        {
          type: "mcpToolCall",
          id: "failed-mcp",
          server: "simulator",
          tool: "build",
          arguments: {},
          error: { message: "Build failed" },
          status: "failed",
        },
        {
          type: "mcpToolCall",
          id: "failed-computer",
          server: "computer-use",
          tool: "click",
          arguments: { app: "Finder" },
          error: { message: "Click failed" },
          result: {
            _meta: {
              "codex/toolSurface": {
                kind: "computerUse",
                app: { kind: "appId", appId: maxLengthAppId },
              },
            },
            content: [],
          },
          status: "failed",
        },
        {
          type: "mcpToolCall",
          id: "failed-computer-collision",
          server: "computer-use",
          tool: "click",
          arguments: { app: "Other" },
          error: { message: "Click failed" },
          result: {
            _meta: {
              "codex/toolSurface": {
                kind: "computerUse",
                app: { kind: "appId", appId: collidingMaxLengthAppId },
              },
            },
            content: [],
          },
          status: "failed",
        },
        {
          type: "fileChange",
          id: "declined-change",
          changes: [],
          status: "declined",
        },
      ] as const;

      for (const item of items) {
        const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

        yield* runtime.emit({
          id: asEventId(`evt-${item.id}`),
          kind: "notification",
          provider: ProviderDriverKind.make("codex"),
          createdAt: "2026-01-01T00:00:00.000Z",
          method: "item/completed",
          threadId: asThreadId("thread-1"),
          turnId: asTurnId("turn-1"),
          itemId: asItemId(item.id),
          payload: {
            completedAtMs: 1_778_000_000_000,
            threadId: "thread-1",
            turnId: "turn-1",
            item,
          },
        });

        const firstEvent = yield* Fiber.join(firstEventFiber);
        NodeAssert.equal(firstEvent._tag, "Some");
        if (firstEvent._tag !== "Some" || firstEvent.value.type !== "item.completed") {
          return;
        }
        NodeAssert.equal(firstEvent.value.payload.status, item.status);
        if (item.id.startsWith("failed-computer")) {
          NodeAssert.equal(firstEvent.value.payload.title, "computer-use · click");
          const sourceKey = firstEvent.value.payload.toolSource?.key;
          NodeAssert.equal(sourceKey?.length, 512);
          if (sourceKey) longAppSourceKeys.push(sourceKey);
        }
      }
      NodeAssert.equal(new Set(longAppSourceKeys).size, 2);
    }),
  );

  it.effect("maps completed plan items to canonical proposed-plan completion events", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      const event: ProviderEvent = {
        id: asEventId("evt-plan-complete"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "item/completed",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        itemId: asItemId("plan_1"),
        payload: {
          completedAtMs: 1_778_000_000_000,
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "plan",
            id: "plan_1",
            text: "## Final plan\n\n- one\n- two",
          },
        },
      };

      yield* runtime.emit(event);
      const firstEvent = yield* Fiber.join(firstEventFiber);

      NodeAssert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      NodeAssert.equal(firstEvent.value.type, "turn.proposed.completed");
      if (firstEvent.value.type !== "turn.proposed.completed") {
        return;
      }
      NodeAssert.equal(firstEvent.value.turnId, "turn-1");
      NodeAssert.equal(firstEvent.value.payload.planMarkdown, "## Final plan\n\n- one\n- two");
    }),
  );

  it.effect("maps plan deltas to canonical proposed-plan delta events", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      yield* runtime.emit({
        id: asEventId("evt-plan-delta"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "item/plan/delta",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        itemId: asItemId("plan_1"),
        payload: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "plan_1",
          delta: "## Final plan",
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      NodeAssert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      NodeAssert.equal(firstEvent.value.type, "turn.proposed.delta");
      if (firstEvent.value.type !== "turn.proposed.delta") {
        return;
      }
      NodeAssert.equal(firstEvent.value.turnId, "turn-1");
      NodeAssert.equal(firstEvent.value.payload.delta, "## Final plan");
    }),
  );

  it.effect("maps interrupted turn completions to canonical interrupted turn events", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      yield* runtime.emit({
        id: asEventId("evt-turn-interrupted"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "turn/completed",
        payload: {
          threadId: "thread-1",
          turn: {
            id: "turn-1",
            status: "interrupted",
            items: [],
          },
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      NodeAssert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      NodeAssert.equal(firstEvent.value.type, "turn.completed");
      if (firstEvent.value.type !== "turn.completed") {
        return;
      }
      NodeAssert.equal(firstEvent.value.turnId, "turn-1");
      NodeAssert.equal(firstEvent.value.payload.state, "interrupted");
    }),
  );

  it.effect("maps Codex turn aborted notifications to canonical turn.aborted events", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      yield* runtime.emit({
        id: asEventId("evt-turn-aborted"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "turn/aborted",
        message: "Interrupted by user.",
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      NodeAssert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      NodeAssert.equal(firstEvent.value.type, "turn.aborted");
      if (firstEvent.value.type !== "turn.aborted") {
        return;
      }
      NodeAssert.equal(firstEvent.value.turnId, "turn-1");
      NodeAssert.equal(firstEvent.value.payload.reason, "Interrupted by user.");
    }),
  );

  it.effect("maps session/closed lifecycle events to canonical session.exited runtime events", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      const event: ProviderEvent = {
        id: asEventId("evt-session-closed"),
        kind: "session",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "session/closed",
        message: "Session stopped",
      };

      yield* runtime.emit(event);
      const firstEvent = yield* Fiber.join(firstEventFiber);

      NodeAssert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      NodeAssert.equal(firstEvent.value.type, "session.exited");
      if (firstEvent.value.type !== "session.exited") {
        return;
      }
      NodeAssert.equal(firstEvent.value.threadId, "thread-1");
      NodeAssert.equal(firstEvent.value.payload.reason, "Session stopped");
    }),
  );

  it.effect("maps retryable Codex error notifications to runtime.warning", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      yield* runtime.emit({
        id: asEventId("evt-retryable-error"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "error",
        turnId: asTurnId("turn-1"),
        payload: {
          threadId: "thread-1",
          turnId: "turn-1",
          error: {
            message: "Reconnecting... 2/5",
          },
          willRetry: true,
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      NodeAssert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      NodeAssert.equal(firstEvent.value.type, "runtime.warning");
      if (firstEvent.value.type !== "runtime.warning") {
        return;
      }
      NodeAssert.equal(firstEvent.value.turnId, "turn-1");
      NodeAssert.equal(firstEvent.value.payload.message, "Reconnecting... 2/5");
    }),
  );

  it.effect("maps process stderr notifications to runtime.warning", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      yield* runtime.emit({
        id: asEventId("evt-process-stderr"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "process/stderr",
        turnId: asTurnId("turn-1"),
        message: "The filename or extension is too long. (os error 206)",
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      NodeAssert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      NodeAssert.equal(firstEvent.value.type, "runtime.warning");
      if (firstEvent.value.type !== "runtime.warning") {
        return;
      }
      NodeAssert.equal(firstEvent.value.turnId, "turn-1");
      NodeAssert.equal(
        firstEvent.value.payload.message,
        "The filename or extension is too long. (os error 206)",
      );
    }),
  );

  it.effect("maps realtime started notifications with upstream realtime session ids", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      yield* runtime.emit({
        id: asEventId("evt-realtime-started"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "thread/realtime/started",
        payload: {
          threadId: "thread-1",
          realtimeSessionId: "realtime-session-1",
          version: "v2",
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      NodeAssert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      NodeAssert.equal(firstEvent.value.type, "thread.realtime.started");
      if (firstEvent.value.type !== "thread.realtime.started") {
        return;
      }
      NodeAssert.equal(firstEvent.value.threadId, "thread-1");
      NodeAssert.equal(firstEvent.value.payload.realtimeSessionId, "realtime-session-1");
    }),
  );

  it.effect("maps fatal websocket stderr notifications to runtime.error", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      yield* runtime.emit({
        id: asEventId("evt-process-stderr-websocket"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "process/stderr",
        turnId: asTurnId("turn-1"),
        message:
          "2026-03-31T18:14:06.833399Z ERROR codex_api::endpoint::responses_websocket: failed to connect to websocket: HTTP error: 503 Service Unavailable, url: wss://chatgpt.com/backend-api/codex/responses",
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      NodeAssert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      NodeAssert.equal(firstEvent.value.type, "runtime.error");
      if (firstEvent.value.type !== "runtime.error") {
        return;
      }
      NodeAssert.equal(firstEvent.value.turnId, "turn-1");
      NodeAssert.equal(firstEvent.value.payload.class, "provider_error");
      NodeAssert.equal(
        firstEvent.value.payload.message,
        "2026-03-31T18:14:06.833399Z ERROR codex_api::endpoint::responses_websocket: failed to connect to websocket: HTTP error: 503 Service Unavailable, url: wss://chatgpt.com/backend-api/codex/responses",
      );
    }),
  );

  it.effect("preserves request type when mapping serverRequest/resolved", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      const event: ProviderEvent = {
        id: asEventId("evt-request-resolved"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "serverRequest/resolved",
        requestKind: "command",
        requestId: ApprovalRequestId.make("req-1"),
        payload: {
          threadId: "thread-1",
          requestId: "req-1",
        },
      };

      yield* runtime.emit(event);
      const firstEvent = yield* Fiber.join(firstEventFiber);

      NodeAssert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      NodeAssert.equal(firstEvent.value.type, "request.resolved");
      if (firstEvent.value.type !== "request.resolved") {
        return;
      }
      NodeAssert.equal(firstEvent.value.payload.requestType, "command_execution_approval");
    }),
  );

  it.effect("names the edited files in an apply-patch approval without a reason", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      yield* runtime.emit({
        id: asEventId("evt-apply-patch"),
        kind: "request",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: "2026-08-24T00:00:00.000Z",
        method: "applyPatchApproval",
        requestKind: "file-change",
        requestId: ApprovalRequestId.make("req-patch"),
        turnId: asTurnId("turn-1"),
        payload: {
          callId: "call-1",
          conversationId: "provider-thread-1",
          fileChanges: {
            "/tmp/removed.md": { type: "delete", content: "gone" },
            "/tmp/added.ts": { type: "add", content: "export {};" },
          },
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      NodeAssert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some" || firstEvent.value.type !== "request.opened") {
        return;
      }
      NodeAssert.equal(firstEvent.value.payload.requestType, "apply_patch_approval");
      NodeAssert.equal(
        firstEvent.value.payload.detail,
        "add /tmp/added.ts\ndelete /tmp/removed.md",
      );
    }),
  );

  it.effect("keeps the reason when an apply-patch approval carries one", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      yield* runtime.emit({
        id: asEventId("evt-apply-patch-reason"),
        kind: "request",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: "2026-08-24T00:00:00.000Z",
        method: "applyPatchApproval",
        requestKind: "file-change",
        requestId: ApprovalRequestId.make("req-patch-reason"),
        turnId: asTurnId("turn-1"),
        payload: {
          callId: "call-2",
          conversationId: "provider-thread-1",
          reason: "Needs to rewrite the changelog",
          fileChanges: { "/tmp/CHANGELOG.md": { type: "add", content: "x" } },
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      NodeAssert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some" || firstEvent.value.type !== "request.opened") {
        return;
      }
      NodeAssert.equal(firstEvent.value.payload.detail, "Needs to rewrite the changelog");
    }),
  );

  it.effect("falls back to the grant root for a file-change approval without a reason", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      yield* runtime.emit({
        id: asEventId("evt-file-change"),
        kind: "request",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: "2026-08-24T00:00:00.000Z",
        method: "item/fileChange/requestApproval",
        requestKind: "file-change",
        requestId: ApprovalRequestId.make("req-file-change"),
        turnId: asTurnId("turn-1"),
        payload: {
          itemId: "item-1",
          grantRoot: "/tmp/workspace",
          startedAtMs: 0,
          threadId: "provider-thread-1",
          turnId: "turn-1",
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      NodeAssert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some" || firstEvent.value.type !== "request.opened") {
        return;
      }
      NodeAssert.equal(firstEvent.value.payload.requestType, "file_change_approval");
      NodeAssert.equal(firstEvent.value.payload.detail, "/tmp/workspace");
    }),
  );

  it.effect("prefers the edited files over a blank apply-patch reason", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      yield* runtime.emit({
        id: asEventId("evt-apply-patch-blank"),
        kind: "request",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: "2026-08-24T00:00:00.000Z",
        method: "applyPatchApproval",
        requestKind: "file-change",
        requestId: ApprovalRequestId.make("req-patch-blank"),
        turnId: asTurnId("turn-1"),
        payload: {
          callId: "call-3",
          conversationId: "provider-thread-1",
          reason: "   ",
          fileChanges: {
            "/tmp/moved.ts": { type: "update", unified_diff: "@@", move_path: "/tmp/renamed.ts" },
          },
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      NodeAssert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some" || firstEvent.value.type !== "request.opened") {
        return;
      }
      NodeAssert.equal(firstEvent.value.payload.detail, "update /tmp/moved.ts -> /tmp/renamed.ts");
    }),
  );

  it.effect("caps the described files in an oversized apply-patch approval", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      const fileChanges = Object.fromEntries(
        Array.from({ length: 25 }, (_unused, index) => [
          `/tmp/file-${String(index).padStart(2, "0")}.ts`,
          { type: "add", content: "x" },
        ]),
      );

      yield* runtime.emit({
        id: asEventId("evt-apply-patch-many"),
        kind: "request",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: "2026-08-24T00:00:00.000Z",
        method: "applyPatchApproval",
        requestKind: "file-change",
        requestId: ApprovalRequestId.make("req-patch-many"),
        turnId: asTurnId("turn-1"),
        payload: { callId: "call-4", conversationId: "provider-thread-1", fileChanges },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      NodeAssert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some" || firstEvent.value.type !== "request.opened") {
        return;
      }
      const detail = firstEvent.value.payload.detail ?? "";
      NodeAssert.equal(detail.split("\n").length, 21);
      NodeAssert.ok(detail.endsWith("+5 more"));
    }),
  );

  it.effect("leaves an apply-patch approval without changes or a reason undetailed", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      yield* runtime.emit({
        id: asEventId("evt-apply-patch-empty"),
        kind: "request",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: "2026-08-24T00:00:00.000Z",
        method: "applyPatchApproval",
        requestKind: "file-change",
        requestId: ApprovalRequestId.make("req-patch-empty"),
        turnId: asTurnId("turn-1"),
        payload: { callId: "call-5", conversationId: "provider-thread-1", fileChanges: {} },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      NodeAssert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some" || firstEvent.value.type !== "request.opened") {
        return;
      }
      NodeAssert.equal(firstEvent.value.payload.detail, undefined);
    }),
  );

  it.effect("maps MCP elicitation requests into app access approvals", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      yield* runtime.emit({
        id: asEventId("evt-mcp-elicitation"),
        kind: "request",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: "2026-08-24T00:00:00.000Z",
        method: "mcpServer/elicitation/request",
        requestKind: "mcp-elicitation",
        requestId: ApprovalRequestId.make("req-safari"),
        turnId: asTurnId("turn-1"),
        payload: {
          mode: "form",
          message: "Allow ChatGPT to use Safari?",
          serverName: "computer-use",
          threadId: "provider-thread-1",
          turnId: "turn-1",
          _meta: { app_name: "Safari", persist: ["session", "always"] },
          requestedSchema: { type: "object", properties: {} },
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      NodeAssert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some" || firstEvent.value.type !== "request.opened") {
        return;
      }
      NodeAssert.equal(firstEvent.value.payload.requestType, "mcp_elicitation_approval");
      NodeAssert.equal(firstEvent.value.payload.appName, "Safari");
      NodeAssert.equal(firstEvent.value.payload.detail, "Allow ChatGPT to use Safari?");
      NodeAssert.deepStrictEqual(firstEvent.value.payload.options, [
        { decision: "cancel", label: "Cancel" },
        { decision: "decline", label: "Decline" },
        { decision: "acceptForSession", label: "Always allow this session" },
        { decision: "acceptAlways", label: "Always allow" },
        { decision: "accept", label: "Approve" },
      ]);
    }),
  );

  it.effect("preserves MCP elicitation type when an app access request resolves", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      yield* runtime.emit({
        id: asEventId("evt-mcp-elicitation-resolved"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: "2026-08-24T00:00:00.000Z",
        method: "item/requestApproval/decision",
        requestKind: "mcp-elicitation",
        requestId: ApprovalRequestId.make("req-safari"),
        payload: { decision: "acceptAlways" },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      NodeAssert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some" || firstEvent.value.type !== "request.resolved") {
        return;
      }
      NodeAssert.equal(firstEvent.value.payload.requestType, "mcp_elicitation_approval");
      NodeAssert.equal(firstEvent.value.payload.decision, "acceptAlways");
    }),
  );

  it.effect("preserves file-read request type when mapping serverRequest/resolved", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      const event: ProviderEvent = {
        id: asEventId("evt-file-read-request-resolved"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "serverRequest/resolved",
        requestKind: "file-read",
        requestId: ApprovalRequestId.make("req-file-read-1"),
        payload: {
          threadId: "thread-1",
          requestId: "req-file-read-1",
        },
      };

      yield* runtime.emit(event);
      const firstEvent = yield* Fiber.join(firstEventFiber);

      NodeAssert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      NodeAssert.equal(firstEvent.value.type, "request.resolved");
      if (firstEvent.value.type !== "request.resolved") {
        return;
      }
      NodeAssert.equal(firstEvent.value.payload.requestType, "file_read_approval");
    }),
  );

  it.effect("preserves explicit empty multi-select user-input answers", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      const event: ProviderEvent = {
        id: asEventId("evt-user-input-empty"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "item/tool/requestUserInput/answered",
        payload: {
          answers: {
            scope: {
              answers: [],
            },
          },
        },
      };

      yield* runtime.emit(event);
      const firstEvent = yield* Fiber.join(firstEventFiber);

      NodeAssert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      NodeAssert.equal(firstEvent.value.type, "user-input.resolved");
      if (firstEvent.value.type !== "user-input.resolved") {
        return;
      }
      NodeAssert.deepEqual(firstEvent.value.payload.answers, {
        scope: [],
      });
    }),
  );

  it.effect("maps windowsSandbox/setupCompleted to session state and warning on failure", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 2)).pipe(
        Effect.forkChild,
      );

      const event: ProviderEvent = {
        id: asEventId("evt-windows-sandbox-failed"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "windowsSandbox/setupCompleted",
        message: "Sandbox setup failed",
        payload: {
          mode: "unelevated",
          success: false,
          error: "unsupported environment",
        },
      };

      yield* runtime.emit(event);
      const events = Array.from(yield* Fiber.join(eventsFiber));

      NodeAssert.equal(events.length, 2);

      const firstEvent = events[0];
      const secondEvent = events[1];

      NodeAssert.equal(firstEvent?.type, "session.state.changed");
      if (firstEvent?.type === "session.state.changed") {
        NodeAssert.equal(firstEvent.payload.state, "error");
        NodeAssert.equal(firstEvent.payload.reason, "Sandbox setup failed");
      }

      NodeAssert.equal(secondEvent?.type, "runtime.warning");
      if (secondEvent?.type === "runtime.warning") {
        NodeAssert.equal(secondEvent.payload.message, "Sandbox setup failed");
      }
    }),
  );

  it.effect(
    "maps requestUserInput requests and answered notifications to canonical user-input events",
    () =>
      Effect.gen(function* () {
        const { adapter, runtime } = yield* startLifecycleRuntime();
        const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 2)).pipe(
          Effect.forkChild,
        );

        yield* runtime.emit({
          id: asEventId("evt-user-input-requested"),
          kind: "request",
          provider: ProviderDriverKind.make("codex"),
          threadId: asThreadId("thread-1"),
          createdAt: "2026-01-01T00:00:00.000Z",
          method: "item/tool/requestUserInput",
          requestId: ApprovalRequestId.make("req-user-input-1"),
          payload: {
            itemId: "item-user-input-1",
            threadId: "thread-1",
            turnId: "turn-1",
            questions: [
              {
                id: "sandbox_mode",
                header: "Sandbox",
                question: "Which mode should be used?",
                options: [
                  {
                    label: "workspace-write",
                    description: "Allow workspace writes only",
                  },
                ],
              },
            ],
          },
        } satisfies ProviderEvent);
        yield* runtime.emit({
          id: asEventId("evt-user-input-resolved"),
          kind: "notification",
          provider: ProviderDriverKind.make("codex"),
          threadId: asThreadId("thread-1"),
          createdAt: "2026-01-01T00:00:00.000Z",
          method: "item/tool/requestUserInput/answered",
          requestId: ApprovalRequestId.make("req-user-input-1"),
          payload: {
            answers: {
              sandbox_mode: {
                answers: ["workspace-write"],
              },
            },
          },
        } satisfies ProviderEvent);

        const events = Array.from(yield* Fiber.join(eventsFiber));
        NodeAssert.equal(events[0]?.type, "user-input.requested");
        if (events[0]?.type === "user-input.requested") {
          NodeAssert.equal(events[0].requestId, "req-user-input-1");
          NodeAssert.equal(events[0].payload.questions[0]?.id, "sandbox_mode");
          NodeAssert.equal(events[0].payload.questions[0]?.multiSelect, false);
        }

        NodeAssert.equal(events[1]?.type, "user-input.resolved");
        if (events[1]?.type === "user-input.resolved") {
          NodeAssert.equal(events[1].requestId, "req-user-input-1");
          NodeAssert.deepEqual(events[1].payload.answers, {
            sandbox_mode: "workspace-write",
          });
        }
      }),
  );

  it.effect("maps async agent questions without ending the turn", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 2)).pipe(
        Effect.forkChild,
      );
      yield* runtime.emit({
        id: asEventId("evt-async-question"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "item/completed",
        payload: {
          completedAtMs: 0,
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "agentMessage",
            id: "async-question-1",
            text: "Which package manager?\n- pnpm\n- npm\n\nWhat should it be named?",
            phase: "final_answer",
            delivery: "async",
            questions: [
              { title: "Which package manager?", options: ["pnpm", "npm"] },
              { title: "What should it be named?" },
            ],
          },
        },
      });
      yield* runtime.emit({
        id: asEventId("evt-async-continued"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: "2026-01-01T00:00:01.000Z",
        method: "item/agentMessage/delta",
        payload: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "message-2",
          delta: "I will keep working.",
        },
      });
      const events = Array.from(yield* Fiber.join(eventsFiber));
      NodeAssert.equal(events[0]?.type, "user-input.requested");
      NodeAssert.equal(events[0]?.requestId, "codex-async:thread-1:async-question-1");
      NodeAssert.deepEqual(events[0]?.payload, {
        responseMode: "message",
        questions: [
          {
            id: "0",
            header: "Question",
            question: "Which package manager?",
            options: [
              { label: "pnpm", description: "" },
              { label: "npm", description: "" },
            ],
            allowCustomAnswer: true,
            multiSelect: false,
          },
          {
            id: "1",
            header: "Question",
            question: "What should it be named?",
            options: [],
            allowCustomAnswer: true,
            multiSelect: false,
          },
        ],
      });
      NodeAssert.equal(events[1]?.type, "content.delta");
    }),
  );

  it.effect("unwraps Codex token usage payloads for context window events", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      yield* runtime.emit({
        id: asEventId("evt-codex-thread-token-usage-updated"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "thread/tokenUsage/updated",
        payload: {
          threadId: "thread-1",
          turnId: "turn-1",
          tokenUsage: {
            total: {
              inputTokens: 11_833,
              cachedInputTokens: 3456,
              outputTokens: 6,
              reasoningOutputTokens: 0,
              totalTokens: 11_839,
            },
            last: {
              inputTokens: 120,
              cachedInputTokens: 0,
              outputTokens: 6,
              reasoningOutputTokens: 0,
              totalTokens: 126,
            },
            modelContextWindow: 258_400,
          },
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);
      NodeAssert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      NodeAssert.equal(firstEvent.value.type, "thread.token-usage.updated");
      if (firstEvent.value.type !== "thread.token-usage.updated") {
        return;
      }

      NodeAssert.deepEqual(firstEvent.value.payload.usage, {
        usedTokens: 126,
        totalProcessedTokens: 11_839,
        maxTokens: 258_400,
        inputTokens: 120,
        cachedInputTokens: 0,
        outputTokens: 6,
        reasoningOutputTokens: 0,
        lastUsedTokens: 126,
        lastInputTokens: 120,
        lastCachedInputTokens: 0,
        lastOutputTokens: 6,
        lastReasoningOutputTokens: 0,
        compactsAutomatically: true,
      });
    }),
  );

  // Production calls startSession from a request fiber that finishes as soon as
  // the session exists. `Effect.forkChild` made the runtime event consumer a
  // child of that fiber, and Effect interrupts a fiber's children when it
  // completes, so the consumer died on return and every event the session
  // emitted afterwards was dropped. The other tests here start the session from
  // the test fiber, which never completes, so the consumer survived and the bug
  // stayed invisible. Starting it in a fiber that finishes reproduces
  // production.
  it.effect("keeps consuming runtime events after the startSession fiber completes", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const startSessionFiber = yield* adapter
        .startSession({
          provider: ProviderDriverKind.make("codex"),
          threadId: asThreadId("thread-outlives-start"),
          runtimeMode: "full-access",
        })
        .pipe(Effect.forkChild);
      yield* Fiber.join(startSessionFiber);

      const runtime = lifecycleRuntimeFactory.lastRuntime;
      NodeAssert.ok(runtime);

      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);
      yield* runtime.emit({
        id: asEventId("evt-after-start-session"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "item/completed",
        threadId: asThreadId("thread-outlives-start"),
        turnId: asTurnId("turn-1"),
        itemId: asItemId("msg_after_start"),
        payload: {
          completedAtMs: 1_778_000_000_000,
          threadId: "thread-outlives-start",
          turnId: "turn-1",
          item: {
            type: "agentMessage",
            id: "msg_after_start",
            text: "emitted after startSession returned",
          },
        },
      });

      const firstEvent = yield* Fiber.join(firstEventFiber).pipe(Effect.timeout("10 seconds"));
      NodeAssert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      NodeAssert.equal(firstEvent.value.type, "item.completed");
      // Live clock so the timeout above is real: under the default test clock it
      // waits on virtual time that never advances, and a regression would hang
      // until the suite timeout instead of failing here.
    }).pipe(TestClock.withLive),
  );

  it.effect("maps Codex goal updates into canonical runtime events", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      yield* runtime.emit({
        id: asEventId("evt-codex-goal-updated"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "thread/goal/updated",
        payload: {
          threadId: "provider-thread-1",
          goal: {
            threadId: "provider-thread-1",
            objective: "Finish goal support",
            status: "active",
            tokenBudget: 50_000,
            tokensUsed: 1_234,
            timeUsedSeconds: 75,
            createdAt: 1_767_225_600,
            updatedAt: 1_767_225_675,
          },
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);
      NodeAssert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some" || firstEvent.value.type !== "thread.goal.updated") {
        return;
      }
      NodeAssert.deepEqual(firstEvent.value.payload.goal, {
        objective: "Finish goal support",
        status: "active",
        tokenBudget: 50_000,
        tokensUsed: 1_234,
        timeUsedSeconds: 75,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:01:15.000Z",
      });
    }),
  );

  it.effect("maps Codex goal clears into canonical runtime events", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      yield* runtime.emit({
        id: asEventId("evt-codex-goal-cleared"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: "2026-01-01T00:02:00.000Z",
        method: "thread/goal/cleared",
        payload: { threadId: "provider-thread-1" },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);
      NodeAssert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some" || firstEvent.value.type !== "thread.goal.cleared") {
        return;
      }
      NodeAssert.deepEqual(firstEvent.value.payload, {});
    }),
  );

  it.effect("forwards an existing goal reconciled during startup", () =>
    Effect.gen(function* () {
      const startupGoalEvent = {
        id: asEventId("evt-codex-goal-startup"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "thread/goal/updated",
        payload: {
          threadId: "provider-thread-1",
          goal: {
            threadId: "provider-thread-1",
            objective: "Restore the existing goal",
            status: "paused",
            tokenBudget: null,
            tokensUsed: 12,
            timeUsedSeconds: 30,
            createdAt: 1_767_225_600,
            updatedAt: 1_767_225_630,
          },
        },
      } satisfies ProviderEvent;
      const { adapter } = yield* startLifecycleRuntime((runtime) => {
        runtime.onStart = () => runtime.emit(startupGoalEvent);
      });

      const firstEvent = yield* Stream.runHead(adapter.streamEvents);
      NodeAssert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some" || firstEvent.value.type !== "thread.goal.updated") {
        return;
      }
      NodeAssert.deepEqual(firstEvent.value.payload.goal, {
        objective: "Restore the existing goal",
        status: "paused",
        tokenBudget: null,
        tokensUsed: 12,
        timeUsedSeconds: 30,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:30.000Z",
      });
    }),
  );

  it.effect("forwards goal mutations to the Codex runtime", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const threadId = asThreadId("thread-1");
      NodeAssert.ok(adapter.setThreadGoal);
      NodeAssert.ok(adapter.clearThreadGoal);

      yield* adapter.setThreadGoal({
        threadId,
        objective: "Finish native goal support",
        status: "active",
        tokenBudget: 50_000,
      });
      yield* adapter.clearThreadGoal(threadId);

      NodeAssert.deepEqual(runtime.setThreadGoalImpl.mock.calls, [
        [
          {
            objective: "Finish native goal support",
            status: "active",
            tokenBudget: 50_000,
          },
        ],
      ]);
      NodeAssert.equal(runtime.clearThreadGoalImpl.mock.calls.length, 1);
    }),
  );
});

const scopedLifecycleRuntimeFactory = makeScopedRuntimeFactory();
const scopedLifecycleLayer = it.layer(
  Layer.effect(
    CodexAdapter,
    Effect.gen(function* () {
      const codexConfig = decodeCodexSettings({});
      return yield* makeCodexAdapter(codexConfig, {
        makeRuntime: scopedLifecycleRuntimeFactory.factory,
      });
    }),
  ).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(providerSessionDirectoryTestLayer),
    Layer.provideMerge(NodeServices.layer),
  ),
);

scopedLifecycleLayer("CodexAdapterLive scoped lifecycle", (it) => {
  it.effect("closes the externally owned session scope on stopSession", () =>
    Effect.gen(function* () {
      scopedLifecycleRuntimeFactory.releasedThreadIds.length = 0;
      const adapter = yield* CodexAdapter;

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-stop"),
        runtimeMode: "full-access",
      });

      const runtime = scopedLifecycleRuntimeFactory.lastRuntime;
      NodeAssert.ok(runtime);

      yield* adapter.stopSession(asThreadId("thread-stop"));

      NodeAssert.equal(runtime.closeImpl.mock.calls.length, 1);
      NodeAssert.deepStrictEqual(scopedLifecycleRuntimeFactory.releasedThreadIds, [
        asThreadId("thread-stop"),
      ]);
      NodeAssert.equal(yield* adapter.hasSession(asThreadId("thread-stop")), false);
    }),
  );
});

const scopedFailureRuntimeFactory = makeScopedRuntimeFactory({ failConstruction: true });
const scopedFailureLayer = it.layer(
  Layer.effect(
    CodexAdapter,
    Effect.gen(function* () {
      const codexConfig = decodeCodexSettings({});
      return yield* makeCodexAdapter(codexConfig, {
        makeRuntime: scopedFailureRuntimeFactory.factory,
      });
    }),
  ).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(providerSessionDirectoryTestLayer),
    Layer.provideMerge(NodeServices.layer),
  ),
);

scopedFailureLayer("CodexAdapterLive scoped startup failure", (it) => {
  it.effect("closes the externally owned session scope when startSession fails", () =>
    Effect.gen(function* () {
      scopedFailureRuntimeFactory.releasedThreadIds.length = 0;
      const adapter = yield* CodexAdapter;

      const result = yield* adapter
        .startSession({
          provider: ProviderDriverKind.make("codex"),
          threadId: asThreadId("thread-fail"),
          runtimeMode: "full-access",
        })
        .pipe(Effect.result);

      NodeAssert.equal(result._tag, "Failure");
      NodeAssert.equal(result.failure._tag, "ProviderAdapterProcessError");
      NodeAssert.deepStrictEqual(scopedFailureRuntimeFactory.releasedThreadIds, [
        asThreadId("thread-fail"),
      ]);
      NodeAssert.equal(yield* adapter.hasSession(asThreadId("thread-fail")), false);
    }),
  );
});

it.effect("flushes managed native logs when the adapter layer shuts down", () =>
  Effect.gen(function* () {
    const tempDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3-codex-adapter-native-log-"),
    );
    const basePath = NodePath.join(tempDir, "provider-native.ndjson");
    const runtimeFactory = makeRuntimeFactory();
    const scope = yield* Scope.make("sequential");
    let scopeClosed = false;

    try {
      const layer = Layer.effect(
        CodexAdapter,
        Effect.gen(function* () {
          const codexConfig = decodeCodexSettings({});
          return yield* makeCodexAdapter(codexConfig, {
            makeRuntime: runtimeFactory.factory,
            nativeEventLogPath: basePath,
          });
        }),
      ).pipe(
        Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
        Layer.provideMerge(ServerSettingsService.layerTest()),
        Layer.provideMerge(providerSessionDirectoryTestLayer),
        Layer.provideMerge(NodeServices.layer),
      );
      const context = yield* Layer.buildWithScope(layer, scope);
      const adapter = yield* Effect.service(CodexAdapter).pipe(Effect.provide(context));

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-logger"),
        runtimeMode: "full-access",
      });

      const runtime = runtimeFactory.lastRuntime;
      NodeAssert.ok(runtime);

      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);
      yield* runtime.emit({
        id: asEventId("evt-native-log"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-logger"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "process/stderr",
        message: "native flush test",
      } satisfies ProviderEvent);
      yield* Fiber.join(firstEventFiber);

      yield* Scope.close(scope, Exit.void);
      scopeClosed = true;

      const threadLogPath = NodePath.join(tempDir, "provider-native.thread-logger.log");
      NodeAssert.equal(NodeFS.existsSync(threadLogPath), true);
      const contents = NodeFS.readFileSync(threadLogPath, "utf8");
      NodeAssert.match(contents, /NTIVE: .*"message":"native flush test"/);
    } finally {
      if (!scopeClosed) {
        yield* Scope.close(scope, Exit.void);
      }
      NodeFS.rmSync(tempDir, { recursive: true, force: true });
    }
  }),
);

const imageContextCodexConfig = decodeCodexSettings({
  customModels: ["text-only-model", "vision-model", "unknown-model"],
  customModelMetadata: {
    "text-only-model": {
      name: "Text-only model",
      capabilities: {
        inputModalities: ["text"],
        optionDescriptors: [],
      },
    },
    "vision-model": {
      name: "Vision model",
      capabilities: {
        inputModalities: ["text", "image"],
        optionDescriptors: [],
      },
    },
    "unknown-model": {
      name: "Unknown model",
    },
  },
});

function makeImageContextAdapterLayer(input: {
  readonly baseDir: string;
  readonly runtimeFactory: ReturnType<typeof makeRuntimeFactory>;
  readonly analyzer: CodexImageContextAnalyzer;
}) {
  return Layer.effect(
    CodexAdapter,
    makeCodexAdapter(imageContextCodexConfig, {
      makeRuntime: input.runtimeFactory.factory,
      imageContextAnalyzer: input.analyzer,
    }),
  ).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), input.baseDir)),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(providerSessionDirectoryTestLayer),
    Layer.provideMerge(NodeServices.layer),
  );
}

function imageAttachment(id: string) {
  return {
    type: "image" as const,
    id,
    name: `${id}.png`,
    mimeType: "image/png",
    sizeBytes: 5,
  };
}

it.effect("keeps generic attachments out of Codex native attachment inputs", () => {
  const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "codex-file-context-"));
  const runtimeFactory = makeRuntimeFactory();
  const analyzer: CodexImageContextAnalyzer = () => Effect.succeed([]);
  const layer = makeImageContextAdapterLayer({ baseDir, runtimeFactory, analyzer });

  return Effect.gen(function* () {
    const adapter = yield* CodexAdapter;
    const threadId = asThreadId("thread-file-context");
    const attachment = {
      type: "file" as const,
      id: "thread-file-context-00000000-0000-4000-8000-000000000001",
      name: "requirements.txt",
      mimeType: "text/plain",
      sizeBytes: 12,
    };
    yield* adapter.startSession({
      provider: ProviderDriverKind.make("codex"),
      threadId,
      modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "text-only-model", []),
      runtimeMode: "full-access",
    });
    yield* adapter.sendTurn({
      threadId,
      input: "Summarize this file.",
      attachments: [attachment],
    });

    const turn = runtimeFactory.lastRuntime?.sendTurnImpl.mock.calls[0]?.[0];
    NodeAssert.equal(turn?.input, "Summarize this file.");
    NodeAssert.equal(Object.hasOwn(turn ?? {}, "attachments"), false);
  }).pipe(
    Effect.provide(layer),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(baseDir, { recursive: true, force: true }))),
  );
});

it.effect("restarts legacy image history before using a text-only model", () => {
  const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "codex-image-resume-"));
  const runtimeFactory = makeRuntimeFactory();
  const analyzer: CodexImageContextAnalyzer = () => Effect.succeed([]);
  const layer = makeImageContextAdapterLayer({ baseDir, runtimeFactory, analyzer });

  return Effect.gen(function* () {
    const adapter = yield* CodexAdapter;
    const textOnlySelection = createModelSelection(
      ProviderInstanceId.make("codex"),
      "text-only-model",
      [],
    );

    const legacySession = yield* adapter.startSession({
      provider: ProviderDriverKind.make("codex"),
      threadId: asThreadId("thread-image-legacy-resume"),
      modelSelection: textOnlySelection,
      resumeCursor: { threadId: "legacy-provider-thread" },
      runtimeMode: "full-access",
    });
    NodeAssert.equal(runtimeFactory.lastRuntime?.options.resumeCursor, undefined);
    NodeAssert.deepStrictEqual(legacySession.resumeCursor, {
      threadId: "provider-thread-1",
      textOnlyImageContextVersion: 1,
    });

    const safeCursor = {
      threadId: "safe-provider-thread",
      dynamicToolNames: ["fixture_records_search"],
      dynamicToolFingerprint: "fixture-tools-v1",
      textOnlyImageContextVersion: 1 as const,
    };
    const safeSession = yield* adapter.startSession({
      provider: ProviderDriverKind.make("codex"),
      threadId: asThreadId("thread-image-safe-resume"),
      modelSelection: textOnlySelection,
      resumeCursor: safeCursor,
      runtimeMode: "full-access",
    });
    NodeAssert.deepStrictEqual(runtimeFactory.lastRuntime?.options.resumeCursor, safeCursor);
    NodeAssert.deepStrictEqual(safeSession.resumeCursor, safeCursor);

    const visionSession = yield* adapter.startSession({
      provider: ProviderDriverKind.make("codex"),
      threadId: asThreadId("thread-image-vision-resume"),
      modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "vision-model", []),
      resumeCursor: safeCursor,
      runtimeMode: "full-access",
    });
    NodeAssert.deepStrictEqual(visionSession.resumeCursor, {
      threadId: "safe-provider-thread",
      dynamicToolNames: ["fixture_records_search"],
      dynamicToolFingerprint: "fixture-tools-v1",
      textOnlyImageContextVersion: 1,
    });
  }).pipe(
    Effect.provide(layer),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(baseDir, { recursive: true, force: true }))),
  );
});

it.effect("marks a resumed thread unsafe after forwarding a raw image", () => {
  const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "codex-image-raw-resume-"));
  const runtimeFactory = makeRuntimeFactory();
  const analyzer: CodexImageContextAnalyzer = () => Effect.succeed([]);
  const layer = makeImageContextAdapterLayer({ baseDir, runtimeFactory, analyzer });

  return Effect.gen(function* () {
    const adapter = yield* CodexAdapter;
    const { attachmentsDir } = yield* ServerConfig;
    const threadId = asThreadId("thread-image-raw-resume");
    const attachment = imageAttachment("thread-image-raw-resume-first");
    NodeFS.writeFileSync(NodePath.join(attachmentsDir, `${attachment.id}.png`), "image");

    yield* adapter.startSession({
      provider: ProviderDriverKind.make("codex"),
      threadId,
      modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "text-only-model", []),
      runtimeMode: "full-access",
    });
    const result = yield* adapter.sendTurn({
      threadId,
      attachments: [attachment],
      modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "vision-model", []),
    });

    NodeAssert.deepStrictEqual(result.resumeCursor, { threadId: "provider-thread-1" });
    NodeAssert.equal(
      runtimeFactory.lastRuntime?.sendTurnImpl.mock.calls[0]?.[0].attachments?.length,
      1,
    );

    const unsafeSwitch = yield* adapter
      .sendTurn({
        threadId,
        input: "Now use the text-only model",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("codex"),
          "text-only-model",
          [],
        ),
      })
      .pipe(Effect.result);
    NodeAssert.equal(unsafeSwitch._tag, "Failure");
    NodeAssert.equal(unsafeSwitch.failure._tag, "ProviderAdapterRequestError");
    NodeAssert.match(unsafeSwitch.failure.message, /raw image history/i);
    NodeAssert.equal(runtimeFactory.lastRuntime?.sendTurnImpl.mock.calls.length, 1);
  }).pipe(
    Effect.provide(layer),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(baseDir, { recursive: true, force: true }))),
  );
});

it.effect("marks a resumed thread unsafe before a raw-image send fails", () => {
  const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "codex-image-raw-failure-"));
  const runtimeFactory = makeRuntimeFactory();
  const analyzer: CodexImageContextAnalyzer = () => Effect.succeed([]);
  const layer = makeImageContextAdapterLayer({ baseDir, runtimeFactory, analyzer });

  return Effect.gen(function* () {
    const adapter = yield* CodexAdapter;
    const { attachmentsDir } = yield* ServerConfig;
    const threadId = asThreadId("thread-image-raw-failure");
    const attachment = imageAttachment("thread-image-raw-failure-first");
    NodeFS.writeFileSync(NodePath.join(attachmentsDir, `${attachment.id}.png`), "image");

    yield* adapter.startSession({
      provider: ProviderDriverKind.make("codex"),
      threadId,
      modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "vision-model", []),
      runtimeMode: "full-access",
    });
    const runtime = runtimeFactory.lastRuntime;
    NodeAssert.ok(runtime);
    runtime.sendTurnImpl.mockRejectedValueOnce(new Error("response stream disconnected"));

    const rawImageSend = yield* Effect.exit(
      adapter.sendTurn({
        threadId,
        attachments: [attachment],
        modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "vision-model", []),
      }),
    );
    NodeAssert.equal(rawImageSend._tag, "Failure");

    const unsafeSwitch = yield* adapter
      .sendTurn({
        threadId,
        input: "Now use the text-only model",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("codex"),
          "text-only-model",
          [],
        ),
      })
      .pipe(Effect.result);
    NodeAssert.equal(unsafeSwitch._tag, "Failure");
    NodeAssert.equal(unsafeSwitch.failure._tag, "ProviderAdapterRequestError");
    NodeAssert.match(unsafeSwitch.failure.message, /raw image history/i);
    NodeAssert.equal(runtime.sendTurnImpl.mock.calls.length, 1);
  }).pipe(
    Effect.provide(layer),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(baseDir, { recursive: true, force: true }))),
  );
});

it.effect("converts images for a selected text-only model and preserves that model later", () => {
  const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "codex-image-context-"));
  const runtimeFactory = makeRuntimeFactory();
  const analyzerInputs: Array<Parameters<CodexImageContextAnalyzer>[0]> = [];
  const analyzer: CodexImageContextAnalyzer = (input) => {
    analyzerInputs.push(input);
    return Effect.succeed(
      input.images.map(() => ({
        description: "A red error banner above a disabled Save button.",
        visibleText: "Permission denied",
      })),
    );
  };
  const layer = makeImageContextAdapterLayer({ baseDir, runtimeFactory, analyzer });

  return Effect.gen(function* () {
    const adapter = yield* CodexAdapter;
    const { attachmentsDir } = yield* ServerConfig;
    const threadId = asThreadId("thread-image-context");
    const firstAttachment = imageAttachment("thread-image-context-first");
    const secondAttachment = imageAttachment("thread-image-context-second");
    NodeFS.writeFileSync(NodePath.join(attachmentsDir, `${firstAttachment.id}.png`), "image");
    NodeFS.writeFileSync(NodePath.join(attachmentsDir, `${secondAttachment.id}.png`), "image");

    yield* adapter.startSession({
      provider: ProviderDriverKind.make("codex"),
      threadId,
      modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "vision-model", []),
      runtimeMode: "full-access",
    });
    const runtime = runtimeFactory.lastRuntime;
    NodeAssert.ok(runtime);
    runtime.sendTurnImpl.mockClear();

    yield* adapter.sendTurn({
      threadId,
      input: "What is wrong here?",
      attachments: [firstAttachment],
      modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "text-only-model", []),
    });

    const selectedModelTurn = runtime.sendTurnImpl.mock.calls[0]?.[0];
    NodeAssert.equal(selectedModelTurn?.model, "text-only-model");
    NodeAssert.match(selectedModelTurn?.input ?? "", /What is wrong here\?/);
    NodeAssert.match(selectedModelTurn?.input ?? "", /UNTRUSTED USER-DERIVED DATA/);
    NodeAssert.match(selectedModelTurn?.input ?? "", /Permission denied/);
    NodeAssert.equal(Object.hasOwn(selectedModelTurn ?? {}, "attachments"), false);

    yield* adapter.sendTurn({
      threadId,
      attachments: [secondAttachment],
    });

    const laterTurn = runtime.sendTurnImpl.mock.calls[1]?.[0];
    NodeAssert.match(laterTurn?.input ?? "", /UNTRUSTED USER-DERIVED DATA/);
    NodeAssert.equal(Object.hasOwn(laterTurn ?? {}, "attachments"), false);
    NodeAssert.equal(analyzerInputs.length, 2);
    NodeAssert.deepStrictEqual(
      analyzerInputs.map((entry) => entry.images[0]?.path),
      [
        NodePath.join(attachmentsDir, `${firstAttachment.id}.png`),
        NodePath.join(attachmentsDir, `${secondAttachment.id}.png`),
      ],
    );
  }).pipe(
    Effect.provide(layer),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(baseDir, { recursive: true, force: true }))),
  );
});

it.effect("keeps raw images for native and unknown modality models", () => {
  const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "codex-native-images-"));
  const runtimeFactory = makeRuntimeFactory();
  let analyzerCalls = 0;
  const analyzer: CodexImageContextAnalyzer = () => {
    analyzerCalls += 1;
    return Effect.succeed([]);
  };
  const layer = makeImageContextAdapterLayer({ baseDir, runtimeFactory, analyzer });

  return Effect.gen(function* () {
    const adapter = yield* CodexAdapter;
    const { attachmentsDir } = yield* ServerConfig;
    const threadId = asThreadId("thread-native-images");
    const attachment = imageAttachment("thread-native-images-first");
    NodeFS.writeFileSync(NodePath.join(attachmentsDir, `${attachment.id}.png`), "image");

    yield* adapter.startSession({
      provider: ProviderDriverKind.make("codex"),
      threadId,
      modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "vision-model", []),
      runtimeMode: "full-access",
    });
    const runtime = runtimeFactory.lastRuntime;
    NodeAssert.ok(runtime);
    runtime.sendTurnImpl.mockClear();

    yield* adapter.sendTurn({ threadId, input: "Inspect", attachments: [attachment] });
    yield* adapter.sendTurn({
      threadId,
      input: "Inspect again",
      attachments: [attachment],
      modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "unknown-model", []),
    });

    NodeAssert.equal(analyzerCalls, 0);
    const [currentModelCall, selectedModelCall] = runtime.sendTurnImpl.mock.calls.map(
      ([call]) => call,
    );
    NodeAssert.equal(currentModelCall?.model, "vision-model");
    NodeAssert.equal(selectedModelCall?.model, "unknown-model");
    for (const call of [currentModelCall, selectedModelCall]) {
      NodeAssert.equal(call.attachments?.length, 1);
      NodeAssert.match(call.attachments?.[0]?.url ?? "", /^data:image\/png;base64,/);
    }
  }).pipe(
    Effect.provide(layer),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(baseDir, { recursive: true, force: true }))),
  );
});

it.effect.each([true, false])(
  "waits for complete image recovery before sending the main turn (recovery succeeds: %s)",
  (recoverySucceeds) => {
    const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "codex-image-recovery-"));
    const runtimeFactory = makeRuntimeFactory();
    const secondStarted = Promise.withResolvers<void>();
    const secondResponse = Promise.withResolvers<Response>();
    const response = (images: ReadonlyArray<{ description: string; visibleText: string }>) =>
      new Response(
        JSON.stringify({ choices: [{ message: { content: JSON.stringify({ images }) } }] }),
      );
    const fetchMock = vi.fn(async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const body = String(init?.body);
      if ((body.match(/data:image\/png;base64,/g) ?? []).length === 2) {
        return response([{ description: "Ambiguous batch output", visibleText: "" }]);
      }
      if (body.includes("recovery-first.png")) {
        return response([{ description: "First recovered image", visibleText: "First text" }]);
      }
      secondStarted.resolve();
      return secondResponse.promise;
    });
    const analyzer: CodexImageContextAnalyzer = (input) =>
      makeCodexImageContextAnalyzer(
        { TRITONAI_API_KEY: "test-key" },
        fetchMock as unknown as typeof fetch,
      ).pipe(
        Effect.flatMap((analyze) => analyze(input)),
        Effect.provide(NodeServices.layer),
      );
    const layer = makeImageContextAdapterLayer({ baseDir, runtimeFactory, analyzer });

    return Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const { attachmentsDir } = yield* ServerConfig;
      const threadId = asThreadId("thread-image-recovery");
      const attachments = [imageAttachment("recovery-first"), imageAttachment("recovery-second")];
      for (const attachment of attachments) {
        NodeFS.writeFileSync(NodePath.join(attachmentsDir, `${attachment.id}.png`), "image");
      }
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("codex"),
        threadId,
        modelSelection: createModelSelection(
          ProviderInstanceId.make("codex"),
          "text-only-model",
          [],
        ),
        runtimeMode: "full-access",
      });
      const runtime = runtimeFactory.lastRuntime;
      NodeAssert.ok(runtime);
      runtime.sendTurnImpl.mockClear();

      const fiber = yield* adapter
        .sendTurn({ threadId, input: "Compare these screenshots", attachments })
        .pipe(Effect.result, Effect.forkChild);
      yield* Effect.promise(() => secondStarted.promise);
      NodeAssert.equal(runtime.sendTurnImpl.mock.calls.length, 0);
      secondResponse.resolve(
        response(
          recoverySucceeds
            ? [{ description: "Second recovered image", visibleText: "Second text" }]
            : [],
        ),
      );
      const result = yield* Fiber.join(fiber);
      NodeAssert.equal(fetchMock.mock.calls.length, 3);
      if (recoverySucceeds) {
        NodeAssert.equal(result._tag, "Success");
        NodeAssert.equal(runtime.sendTurnImpl.mock.calls.length, 1);
        const turn = runtime.sendTurnImpl.mock.calls[0]![0];
        NodeAssert.match(turn.input ?? "", /Compare these screenshots/);
        NodeAssert.match(turn.input ?? "", /UNTRUSTED USER-DERIVED DATA/);
        NodeAssert.match(turn.input ?? "", /First recovered image[\s\S]*Second recovered image/);
        NodeAssert.doesNotMatch(turn.input ?? "", /Ambiguous batch output/);
        NodeAssert.equal(Object.hasOwn(turn, "attachments"), false);
      } else {
        NodeAssert.equal(result._tag, "Failure");
        NodeAssert.match(result.failure.message, /main turn was not sent/i);
        NodeAssert.match(result.failure.message, /recovery-second.png/);
        NodeAssert.equal(runtime.sendTurnImpl.mock.calls.length, 0);
      }
    }).pipe(
      Effect.provide(layer),
      Effect.ensuring(Effect.sync(() => NodeFS.rmSync(baseDir, { recursive: true, force: true }))),
    );
  },
);

it.effect("does not send the main turn when image analysis fails", () => {
  const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "codex-image-failure-"));
  const runtimeFactory = makeRuntimeFactory();
  const analyzer: CodexImageContextAnalyzer = () =>
    Effect.fail(
      new CodexImageContextAnalysisError({
        detail: "helper unavailable",
      }),
    );
  const layer = makeImageContextAdapterLayer({ baseDir, runtimeFactory, analyzer });

  return Effect.gen(function* () {
    const adapter = yield* CodexAdapter;
    const { attachmentsDir } = yield* ServerConfig;
    const threadId = asThreadId("thread-image-failure");
    const attachment = imageAttachment("thread-image-failure-first");
    NodeFS.writeFileSync(NodePath.join(attachmentsDir, `${attachment.id}.png`), "image");

    yield* adapter.startSession({
      provider: ProviderDriverKind.make("codex"),
      threadId,
      modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "text-only-model", []),
      runtimeMode: "full-access",
    });
    const runtime = runtimeFactory.lastRuntime;
    NodeAssert.ok(runtime);
    runtime.sendTurnImpl.mockClear();

    const result = yield* adapter
      .sendTurn({ threadId, attachments: [attachment] })
      .pipe(Effect.result);

    NodeAssert.equal(result._tag, "Failure");
    NodeAssert.equal(result.failure._tag, "ProviderAdapterRequestError");
    NodeAssert.match(result.failure.message, /main turn was not sent/i);
    NodeAssert.equal(runtime.sendTurnImpl.mock.calls.length, 0);
  }).pipe(
    Effect.provide(layer),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(baseDir, { recursive: true, force: true }))),
  );
});

it.effect("cancels image analysis before sending the main turn when interrupted", () => {
  const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "codex-image-cancel-"));
  const runtimeFactory = makeRuntimeFactory();
  const analysisStarted = Promise.withResolvers<void>();
  const analyzer: CodexImageContextAnalyzer = (input) => {
    analysisStarted.resolve();
    return Effect.tryPromise({
      try: () =>
        new Promise<ReadonlyArray<{ description: string; visibleText: string }>>(
          (_resolve, reject) => {
            input.signal?.addEventListener("abort", () => reject(new Error("cancelled")), {
              once: true,
            });
          },
        ),
      catch: (cause) =>
        new CodexImageContextAnalysisError({
          detail: "cancelled",
          cause,
        }),
    });
  };
  const layer = makeImageContextAdapterLayer({ baseDir, runtimeFactory, analyzer });

  return Effect.gen(function* () {
    const adapter = yield* CodexAdapter;
    const { attachmentsDir } = yield* ServerConfig;
    const threadId = asThreadId("thread-image-cancel");
    const attachment = imageAttachment("thread-image-cancel-first");
    NodeFS.writeFileSync(NodePath.join(attachmentsDir, `${attachment.id}.png`), "image");

    yield* adapter.startSession({
      provider: ProviderDriverKind.make("codex"),
      threadId,
      modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "text-only-model", []),
      runtimeMode: "full-access",
    });
    const runtime = runtimeFactory.lastRuntime;
    NodeAssert.ok(runtime);
    runtime.sendTurnImpl.mockClear();
    runtime.interruptTurnImpl.mockClear();

    const sendTurnFiber = yield* adapter
      .sendTurn({ threadId, attachments: [attachment] })
      .pipe(Effect.forkChild);
    yield* Effect.promise(() => analysisStarted.promise);
    yield* adapter.interruptTurn(threadId);
    const exit = yield* Fiber.await(sendTurnFiber);

    NodeAssert.equal(Exit.isFailure(exit), true);
    if (Exit.isFailure(exit)) {
      NodeAssert.equal(Cause.hasInterruptsOnly(exit.cause), true);
    }
    NodeAssert.equal(runtime.sendTurnImpl.mock.calls.length, 0);
    NodeAssert.equal(runtime.interruptTurnImpl.mock.calls.length, 1);
  }).pipe(
    Effect.provide(layer),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(baseDir, { recursive: true, force: true }))),
  );
});

it.effect("serializes a newer turn without cancelling active image analysis", () => {
  const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "codex-image-superseded-"));
  const runtimeFactory = makeRuntimeFactory();
  const analysisStarted = Promise.withResolvers<void>();
  const releaseAnalysis = Promise.withResolvers<void>();
  const analyzer: CodexImageContextAnalyzer = (input) => {
    analysisStarted.resolve();
    return Effect.promise(async () => {
      await releaseAnalysis.promise;
      return input.images.map(() => ({ description: "fixture", visibleText: "fixture" }));
    });
  };
  const layer = makeImageContextAdapterLayer({ baseDir, runtimeFactory, analyzer });

  return Effect.gen(function* () {
    const adapter = yield* CodexAdapter;
    const { attachmentsDir } = yield* ServerConfig;
    const threadId = asThreadId("thread-image-superseded");
    const attachment = imageAttachment("thread-image-superseded-first");
    NodeFS.writeFileSync(NodePath.join(attachmentsDir, `${attachment.id}.png`), "image");

    yield* adapter.startSession({
      provider: ProviderDriverKind.make("codex"),
      threadId,
      modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "text-only-model", []),
      runtimeMode: "full-access",
    });
    const runtime = runtimeFactory.lastRuntime;
    NodeAssert.ok(runtime);
    runtime.sendTurnImpl.mockClear();

    const firstTurnFiber = yield* adapter
      .sendTurn({ threadId, input: "Older turn", attachments: [attachment] })
      .pipe(Effect.forkChild);
    yield* Effect.promise(() => analysisStarted.promise);
    const secondTurnFiber = yield* adapter
      .sendTurn({ threadId, input: "Newer turn" })
      .pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    NodeAssert.equal(runtime.sendTurnImpl.mock.calls.length, 0);
    releaseAnalysis.resolve();
    yield* Fiber.join(firstTurnFiber);
    yield* Fiber.join(secondTurnFiber);

    NodeAssert.equal(runtime.sendTurnImpl.mock.calls.length, 2);
    NodeAssert.match(runtime.sendTurnImpl.mock.calls[0]?.[0].input ?? "", /^Older turn/u);
    NodeAssert.deepStrictEqual(runtime.sendTurnImpl.mock.calls[1]?.[0], { input: "Newer turn" });
  }).pipe(
    Effect.provide(layer),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(baseDir, { recursive: true, force: true }))),
  );
});

it.effect("serializes every queued image turn without superseding it", () => {
  const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "codex-image-queued-cancel-"));
  const runtimeFactory = makeRuntimeFactory();
  let analyzerCalls = 0;
  const analyzer: CodexImageContextAnalyzer = (input) => {
    analyzerCalls += 1;
    return Effect.succeed(
      input.images.map(() => ({ description: "fixture", visibleText: "fixture" })),
    );
  };
  const layer = makeImageContextAdapterLayer({ baseDir, runtimeFactory, analyzer });

  return Effect.gen(function* () {
    const adapter = yield* CodexAdapter;
    const { attachmentsDir } = yield* ServerConfig;
    const threadId = asThreadId("thread-image-queued-cancel");
    const attachment = imageAttachment("thread-image-queued-cancel-first");
    NodeFS.writeFileSync(NodePath.join(attachmentsDir, `${attachment.id}.png`), "image");

    yield* adapter.startSession({
      provider: ProviderDriverKind.make("codex"),
      threadId,
      modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "text-only-model", []),
      runtimeMode: "full-access",
    });
    const runtime = runtimeFactory.lastRuntime;
    NodeAssert.ok(runtime);
    runtime.sendTurnImpl.mockClear();
    const preparationStarted = Promise.withResolvers<void>();
    const releasePreparation = Promise.withResolvers<void>();
    runtime.onGetSession = async () => {
      runtime.onGetSession = undefined;
      preparationStarted.resolve();
      await releasePreparation.promise;
    };

    const firstTurnFiber = yield* adapter
      .sendTurn({ threadId, input: "Older turn", attachments: [attachment] })
      .pipe(Effect.forkChild);
    yield* Effect.promise(() => preparationStarted.promise);
    const secondTurnFiber = yield* adapter
      .sendTurn({ threadId, input: "Middle turn", attachments: [attachment] })
      .pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    const thirdTurnFiber = yield* adapter
      .sendTurn({ threadId, input: "Newest turn" })
      .pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    releasePreparation.resolve();
    yield* Fiber.join(firstTurnFiber);
    yield* Fiber.join(secondTurnFiber);
    yield* Fiber.join(thirdTurnFiber);

    NodeAssert.equal(analyzerCalls, 2);
    NodeAssert.equal(runtime.sendTurnImpl.mock.calls.length, 3);
    NodeAssert.match(runtime.sendTurnImpl.mock.calls[0]?.[0].input ?? "", /^Older turn/u);
    NodeAssert.match(runtime.sendTurnImpl.mock.calls[1]?.[0].input ?? "", /^Middle turn/u);
    NodeAssert.deepStrictEqual(runtime.sendTurnImpl.mock.calls[2]?.[0], { input: "Newest turn" });
  }).pipe(
    Effect.provide(layer),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(baseDir, { recursive: true, force: true }))),
  );
});

it.effect("does not send generated image context beyond the turn input limit", () => {
  const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "codex-image-limit-"));
  const runtimeFactory = makeRuntimeFactory();
  const analyzer: CodexImageContextAnalyzer = (input) =>
    Effect.succeed(
      input.images.map(() => ({
        description: "x".repeat(16_000),
        visibleText: "y".repeat(16_000),
      })),
    );
  const layer = makeImageContextAdapterLayer({ baseDir, runtimeFactory, analyzer });

  return Effect.gen(function* () {
    const adapter = yield* CodexAdapter;
    const { attachmentsDir } = yield* ServerConfig;
    const threadId = asThreadId("thread-image-limit");
    const attachments = Array.from({ length: 4 }, (_, index) =>
      imageAttachment(`thread-image-limit-${index}`),
    );
    for (const attachment of attachments) {
      NodeFS.writeFileSync(NodePath.join(attachmentsDir, `${attachment.id}.png`), "image");
    }

    yield* adapter.startSession({
      provider: ProviderDriverKind.make("codex"),
      threadId,
      modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "text-only-model", []),
      runtimeMode: "full-access",
    });
    const runtime = runtimeFactory.lastRuntime;
    NodeAssert.ok(runtime);
    runtime.sendTurnImpl.mockClear();

    const error = yield* Effect.flip(adapter.sendTurn({ threadId, input: "Inspect", attachments }));

    NodeAssert.equal(error._tag, "ProviderAdapterRequestError");
    NodeAssert.match(error.message, /exceeds the turn input limit/i);
    NodeAssert.equal(runtime.sendTurnImpl.mock.calls.length, 0);
  }).pipe(
    Effect.provide(layer),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(baseDir, { recursive: true, force: true }))),
  );
});

const usageLimitRuntimeFactory = makeRuntimeFactory();
const usageLimitLayer = it.layer(
  Layer.effect(
    CodexAdapter,
    Effect.gen(function* () {
      const codexConfig = decodeCodexSettings({});
      return yield* makeCodexAdapter(codexConfig, {
        makeRuntime: usageLimitRuntimeFactory.factory,
      });
    }),
  ).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(providerSessionDirectoryTestLayer),
    Layer.provideMerge(NodeServices.layer),
  ),
);

const USAGE_LIMIT_NOW = "2026-01-01T00:00:00.000Z";
const USAGE_LIMIT_NOW_SECONDS = Date.parse(USAGE_LIMIT_NOW) / 1000;
const CODEX_OUT_OF_CREDITS =
  "Your workspace is out of credits. Ask your workspace owner to refill in order to continue.";

function startUsageLimitRuntime() {
  return Effect.gen(function* () {
    const adapter = yield* CodexAdapter;
    yield* adapter.startSession({
      provider: ProviderDriverKind.make("codex"),
      threadId: asThreadId("thread-1"),
      runtimeMode: "full-access",
    });
    const runtime = usageLimitRuntimeFactory.lastRuntime;
    NodeAssert.ok(runtime);
    return { adapter, runtime };
  });
}

function codexErrorNotification(input: {
  readonly id: string;
  readonly message: string;
  readonly codexErrorInfo?: string;
}): ProviderEvent {
  return {
    id: asEventId(input.id),
    kind: "notification",
    provider: ProviderDriverKind.make("codex"),
    threadId: asThreadId("thread-1"),
    turnId: asTurnId("turn-limit"),
    createdAt: USAGE_LIMIT_NOW,
    method: "error",
    payload: {
      threadId: "thread-1",
      turnId: "turn-limit",
      willRetry: false,
      error: {
        message: input.message,
        ...(input.codexErrorInfo ? { codexErrorInfo: input.codexErrorInfo } : {}),
      },
    },
  };
}

function codexRateLimitsNotification(input: {
  readonly id: string;
  readonly rateLimitReachedType?: string;
  readonly primary?: { readonly usedPercent: number; readonly resetsInSeconds: number };
  readonly secondary?: { readonly usedPercent: number; readonly resetsInSeconds: number };
}): ProviderEvent {
  return {
    id: asEventId(input.id),
    kind: "notification",
    provider: ProviderDriverKind.make("codex"),
    threadId: asThreadId("thread-1"),
    turnId: asTurnId("turn-limit"),
    createdAt: USAGE_LIMIT_NOW,
    method: "account/rateLimits/updated",
    payload: {
      rateLimits: {
        limitId: "codex",
        ...(input.rateLimitReachedType ? { rateLimitReachedType: input.rateLimitReachedType } : {}),
        ...(input.primary
          ? {
              primary: {
                usedPercent: input.primary.usedPercent,
                resetsAt: USAGE_LIMIT_NOW_SECONDS + input.primary.resetsInSeconds,
                windowDurationMins: 300,
              },
            }
          : {}),
        ...(input.secondary
          ? {
              secondary: {
                usedPercent: input.secondary.usedPercent,
                resetsAt: USAGE_LIMIT_NOW_SECONDS + input.secondary.resetsInSeconds,
                windowDurationMins: 10_080,
              },
            }
          : {}),
      },
    },
  };
}

function codexUsageLimitTurnFailed(id: string, turnId = "turn-limit"): ProviderEvent {
  return {
    id: asEventId(id),
    kind: "notification",
    provider: ProviderDriverKind.make("codex"),
    threadId: asThreadId("thread-1"),
    turnId: asTurnId(turnId),
    createdAt: USAGE_LIMIT_NOW,
    method: "turn/completed",
    payload: {
      threadId: "thread-1",
      turn: {
        id: turnId,
        items: [],
        status: "failed",
        error: { message: CODEX_OUT_OF_CREDITS, codexErrorInfo: "usageLimitExceeded" },
      },
    },
  };
}

usageLimitLayer("CodexAdapterLive usage limits", (it) => {
  it.effect("names the exhausted window and the workspace's missing credits", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startUsageLimitRuntime();
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.take(5),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* runtime.emit(
        codexErrorNotification({
          id: "evt-limit-error",
          message: CODEX_OUT_OF_CREDITS,
          codexErrorInfo: "usageLimitExceeded",
        }),
      );
      yield* runtime.emit(
        codexRateLimitsNotification({
          id: "evt-limit-rate-limits",
          rateLimitReachedType: "workspace_owner_credits_depleted",
          primary: { usedPercent: 40, resetsInSeconds: 3_600 },
          secondary: { usedPercent: 100, resetsInSeconds: 5 * 86_400 + 5 * 3_600 },
        }),
      );
      yield* runtime.emit(codexUsageLimitTurnFailed("evt-limit-turn"));
      // A second turn stopping on the same limit says as much as the first.
      yield* runtime.emit(codexUsageLimitTurnFailed("evt-limit-turn-2", "turn-limit-2"));

      const events = Array.from(yield* Fiber.join(eventsFiber));
      const expected =
        "Codex usage limit reached. The weekly limit resets in 5d 5h. The workspace has no credits to continue sooner: ask your workspace owner to add credits, or send the message again once the limit resets.";
      NodeAssert.deepStrictEqual(
        events.map((event) => event.type),
        [
          "account.rate-limits.updated",
          "runtime.error",
          "turn.completed",
          "runtime.error",
          "turn.completed",
        ],
      );
      for (const event of events) {
        if (event.type === "runtime.error") {
          NodeAssert.equal(event.payload.message, expected);
          NodeAssert.equal(event.payload.detail, CODEX_OUT_OF_CREDITS);
        }
        if (event.type === "turn.completed") {
          NodeAssert.equal(event.payload.errorMessage, expected);
        }
      }
    }),
  );

  it.effect("names the session window for a plan limit", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startUsageLimitRuntime();
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.take(3),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* runtime.emit(
        codexErrorNotification({
          id: "evt-plan-error",
          message: "You've hit your usage limit.",
          codexErrorInfo: "usageLimitExceeded",
        }),
      );
      yield* runtime.emit(
        codexRateLimitsNotification({
          id: "evt-plan-rate-limits",
          rateLimitReachedType: "rate_limit_reached",
          primary: { usedPercent: 100, resetsInSeconds: 3 * 3_600 + 20 * 60 },
        }),
      );
      yield* runtime.emit(codexUsageLimitTurnFailed("evt-plan-turn"));

      const events = Array.from(yield* Fiber.join(eventsFiber));
      const completed = events.find((event) => event.type === "turn.completed");
      NodeAssert.equal(
        completed?.payload.errorMessage,
        "Codex usage limit reached. The session limit resets in 3h 20m. Send the message again once the limit resets.",
      );
    }),
  );

  it.effect("reads a rate-limit snapshot seen earlier in the session", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startUsageLimitRuntime();
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.take(3),
        Stream.runCollect,
        Effect.forkChild,
      );

      // The window arrives long before the stop, and the update that reports the
      // limit as reached carries no windows of its own.
      yield* runtime.emit(
        codexRateLimitsNotification({
          id: "evt-early-rate-limits",
          primary: { usedPercent: 100, resetsInSeconds: 3 * 3_600 + 20 * 60 },
        }),
      );
      yield* runtime.emit(
        codexRateLimitsNotification({
          id: "evt-sparse-rate-limits",
          rateLimitReachedType: "rate_limit_reached",
        }),
      );
      yield* runtime.emit(codexUsageLimitTurnFailed("evt-early-turn"));

      const events = Array.from(yield* Fiber.join(eventsFiber));
      const completed = events.find((event) => event.type === "turn.completed");
      NodeAssert.equal(
        completed?.payload.errorMessage,
        "Codex usage limit reached. The session limit resets in 3h 20m. Send the message again once the limit resets.",
      );
    }),
  );

  it.effect("falls back to the short message without a rate-limit snapshot", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startUsageLimitRuntime();
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* runtime.emit(
        codexErrorNotification({
          id: "evt-bare-error",
          message: CODEX_OUT_OF_CREDITS,
          codexErrorInfo: "usageLimitExceeded",
        }),
      );
      yield* runtime.emit(codexUsageLimitTurnFailed("evt-bare-turn"));

      const events = Array.from(yield* Fiber.join(eventsFiber));
      const expected = "Codex usage limit reached. Send the message again once the limit resets.";
      NodeAssert.deepStrictEqual(
        events.map((event) => event.type),
        ["runtime.error", "turn.completed"],
      );
      const runtimeError = events.find((event) => event.type === "runtime.error");
      NodeAssert.equal(runtimeError?.payload.message, expected);
      const completed = events.find((event) => event.type === "turn.completed");
      NodeAssert.equal(completed?.payload.errorMessage, expected);
    }),
  );

  it.effect("still relays other provider errors as they arrive", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startUsageLimitRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      yield* runtime.emit(
        codexErrorNotification({
          id: "evt-other-error",
          message: "Codex is temporarily unavailable.",
          codexErrorInfo: "internalServerError",
        }),
      );

      const first = yield* Fiber.join(firstEventFiber);
      NodeAssert.equal(first._tag, "Some");
      if (first._tag !== "Some" || first.value.type !== "runtime.error") return;
      NodeAssert.equal(first.value.payload.message, "Codex is temporarily unavailable.");
      NodeAssert.equal(first.value.payload.class, "provider_error");
    }),
  );
});
