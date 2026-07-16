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
import * as CodexErrors from "effect-codex-app-server/errors";

import { ServerConfig } from "../../config.ts";
import {
  codexDynamicIntegrationToolName,
  type RegistryRuntime,
} from "../../integrations/IntegrationRegistry.ts";
import { EmptyIntegrationToolInput } from "../../integrations/IntegrationTool.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
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
import { makeCodexAdapter } from "./CodexAdapter.ts";
import {
  CodexImageContextAnalysisError,
  type CodexImageContextAnalyzer,
} from "./CodexImageContext.ts";
const decodeCodexSettings = Schema.decodeSync(CodexSettings);

it("flattens plugin component names into provider-safe function names", () => {
  NodeAssert.equal(
    codexDynamicIntegrationToolName("fixture.records.search"),
    "fixture_records_search",
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

  public readonly interruptTurnImpl = vi.fn(
    (_turnId?: TurnId): Promise<void> => Promise.resolve(undefined),
  );

  public readonly readThreadImpl = vi.fn(
    (): Promise<CodexThreadSnapshot> =>
      Promise.resolve({
        threadId: "provider-thread-1",
        turns: [],
      }),
  );

  public readonly rollbackThreadImpl = vi.fn(
    (_numTurns: number): Promise<CodexThreadSnapshot> =>
      Promise.resolve({
        threadId: "provider-thread-1",
        turns: [],
      }),
  );

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
    return Effect.promise(() => this.startImpl());
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
  const factory = vi.fn((options: CodexSessionRuntimeOptions) => {
    const runtime = new FakeCodexRuntime(options);
    runtimes.push(runtime);
    return Effect.succeed(runtime);
  });

  return {
    factory,
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
      const codexConfig = decodeCodexSettings({});
      return yield* makeCodexAdapter(codexConfig, {
        makeRuntime: validationRuntimeFactory.factory,
      });
    }),
  ).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(providerSessionDirectoryTestLayer),
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

      NodeAssert.deepStrictEqual(validationRuntimeFactory.factory.mock.calls[0]?.[0], {
        binaryPath: "codex",
        cwd: process.cwd(),
        model: "gpt-5.3-codex",
        providerInstanceId: ProviderInstanceId.make("codex"),
        serviceTier: "priority",
        threadId: asThreadId("thread-1"),
        runtimeMode: "full-access",
      });
    }),
  );
  it.effect("disables the TritonAI MCP namespace while preserving session wiring", () =>
    Effect.gen(function* () {
      validationRuntimeFactory.factory.mockClear();
      const adapter = yield* CodexAdapter;
      const threadId = asThreadId("thread-mcp-namespace-disabled");
      McpProviderSession.setMcpProviderSession({
        environmentId: EnvironmentId.make("environment-1"),
        threadId,
        providerSessionId: "provider-session-1",
        providerInstanceId: ProviderInstanceId.make("codex"),
        endpoint: "http://127.0.0.1:43123/mcp",
        authorizationHeader: "Bearer test-token",
      });

      try {
        yield* adapter.startSession({
          provider: ProviderDriverKind.make("codex"),
          threadId,
          runtimeMode: "full-access",
        });

        NodeAssert.deepStrictEqual(validationRuntimeFactory.factory.mock.calls[0]?.[0], {
          appServerArgs: [
            "-c",
            "mcp_servers.t3-code.url=http://127.0.0.1:43123/mcp",
            "-c",
            'mcp_servers.t3-code.bearer_token_env_var="T3_MCP_BEARER_TOKEN"',
            "-c",
            "mcp_servers.t3-code.enabled=false",
          ],
          binaryPath: "codex",
          cwd: process.cwd(),
          environment: {
            ...process.env,
            T3_MCP_BEARER_TOKEN: "test-token",
          },
          providerInstanceId: ProviderInstanceId.make("codex"),
          threadId,
          runtimeMode: "full-access",
        });
      } finally {
        McpProviderSession.clearMcpProviderSession(threadId);
      }
    }),
  );
});

const reconciliationRuntimeFactory = makeRuntimeFactory();
const reconciliationAvailability = {
  generation: 0,
  available: false,
  advancesDuringPrepare: 0,
};
const reconciliationToolName = "fixture.records.search";
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
  ],
  isToolAvailableSync: () => reconciliationAvailability.available,
  isSkillAvailableSync: () => false,
  reserveSkillsSync: () => null,
  invokeTool: () => Promise.resolve({ records: [] }),
} as unknown as RegistryRuntime;

const reconciliationLayer = it.layer(
  Layer.effect(
    CodexAdapter,
    makeCodexAdapter(decodeCodexSettings({}), {
      makeRuntime: reconciliationRuntimeFactory.factory,
      integrationRegistry: reconciliationRegistry,
    }),
  ).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(providerSessionDirectoryTestLayer),
    Layer.provideMerge(NodeServices.layer),
  ),
);

reconciliationLayer("CodexAdapter integration availability reconciliation", (it) => {
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

      releaseRead.resolve();
      const sendExit = yield* Fiber.await(send);
      NodeAssert.equal(Exit.isFailure(sendExit), true);
      if (Exit.isFailure(sendExit)) {
        NodeAssert.equal(Cause.hasInterruptsOnly(sendExit.cause), true);
      }
      NodeAssert.equal(runtime.sendTurnImpl.mock.calls.length, 0);
      NodeAssert.equal(reconciliationRuntimeFactory.factory.mock.calls.length, 1);
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
      NodeAssert.equal(reconciliationRuntimeFactory.factory.mock.calls.length, 1);
      NodeAssert.equal(yield* adapter.hasSession(threadId), false);
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
        [codexDynamicIntegrationToolName(reconciliationToolName)],
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
      const binding = activeRuntime.options.dynamicTools?.[0];
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

function startLifecycleRuntime() {
  return Effect.gen(function* () {
    const adapter = yield* CodexAdapter;
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

lifecycleLayer("CodexAdapterLive lifecycle", (it) => {
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

      const threadLogPath = NodePath.join(tempDir, "thread-logger.log");
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

it.effect("cancels pending image analysis before dispatching a newer turn", () => {
  const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "codex-image-superseded-"));
  const runtimeFactory = makeRuntimeFactory();
  const analysisStarted = Promise.withResolvers<void>();
  const analyzer: CodexImageContextAnalyzer = (input) => {
    analysisStarted.resolve();
    return Effect.tryPromise({
      try: () =>
        new Promise<ReadonlyArray<{ description: string; visibleText: string }>>(
          (_resolve, reject) => {
            input.signal?.addEventListener("abort", () => reject(new Error("superseded")), {
              once: true,
            });
          },
        ),
      catch: (cause) =>
        new CodexImageContextAnalysisError({
          detail: "superseded",
          cause,
        }),
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
    yield* adapter.sendTurn({ threadId, input: "Newer turn" });
    const firstTurnExit = yield* Fiber.await(firstTurnFiber);

    NodeAssert.equal(Exit.isFailure(firstTurnExit), true);
    if (Exit.isFailure(firstTurnExit)) {
      NodeAssert.equal(Cause.hasInterruptsOnly(firstTurnExit.cause), true);
    }
    NodeAssert.equal(runtime.sendTurnImpl.mock.calls.length, 1);
    NodeAssert.deepStrictEqual(runtime.sendTurnImpl.mock.calls[0]?.[0], { input: "Newer turn" });
  }).pipe(
    Effect.provide(layer),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(baseDir, { recursive: true, force: true }))),
  );
});

it.effect("cancels every superseded image turn before queued analysis starts", () => {
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
    const firstTurnExit = yield* Fiber.await(firstTurnFiber);
    const secondTurnExit = yield* Fiber.await(secondTurnFiber);
    yield* Fiber.join(thirdTurnFiber);

    NodeAssert.equal(Exit.isFailure(firstTurnExit), true);
    if (Exit.isFailure(firstTurnExit)) {
      NodeAssert.equal(Cause.hasInterruptsOnly(firstTurnExit.cause), true);
    }
    NodeAssert.equal(Exit.isFailure(secondTurnExit), true);
    if (Exit.isFailure(secondTurnExit)) {
      NodeAssert.equal(Cause.hasInterruptsOnly(secondTurnExit.cause), true);
    }
    NodeAssert.equal(analyzerCalls, 0);
    NodeAssert.equal(runtime.sendTurnImpl.mock.calls.length, 1);
    NodeAssert.deepStrictEqual(runtime.sendTurnImpl.mock.calls[0]?.[0], { input: "Newest turn" });
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
