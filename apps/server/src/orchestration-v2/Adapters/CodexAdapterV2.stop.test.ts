import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CodexSettings,
  MessageId,
  NodeId,
  ProjectId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestrationV2AppThread,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as CodexClient from "effect-codex-app-server/client";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as CodexAdapterV2 from "./CodexAdapterV2.ts";
import { makeReplayServerConfig } from "./CodexAdapterV2.testkit.ts";

const defaultCodexSettings = Schema.decodeSync(CodexSettings)({});

it.live.each(["success", "retry", "missing-ack", "natural-completion"] as const)(
  "withholds Stop acknowledgment until the owned foreground process is contained (%s)",
  (mode) =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "codex-stop-process-" });
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const handle = yield* spawner.spawn(
          ChildProcess.make(yield* HostProcess.ExecutablePath, [
            path.join(import.meta.dirname, "../../provider/testFixtures/codexStopMockPeer.mjs"),
            cwd,
            mode,
          ]),
        );
        const clientContext = yield* Layer.build(CodexClient.layerChildProcess(handle));
        const client = Context.get(clientContext, CodexClient.CodexAppServerClient);
        const terminationPending = yield* Deferred.make<void>();
        yield* client.handleUnknownServerNotification((method) =>
          method === "fixture/terminationPending"
            ? Deferred.succeed(terminationPending, undefined).pipe(Effect.asVoid)
            : Effect.void,
        );
        const instanceId = CodexAdapterV2.CODEX_DEFAULT_INSTANCE_ID;
        const modelSelection = { instanceId, model: "gpt-5.4" };
        const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd,
        });
        const adapter = yield* CodexAdapterV2.makeCodexAdapterV2({
          instanceId,
          settings: defaultCodexSettings,
          environment: {},
          clientFactory: { open: () => Effect.succeed(client) },
          crypto: yield* Crypto.Crypto,
          fileSystem: fs,
          idAllocator: yield* IdAllocator.IdAllocatorV2,
          serverConfig: yield* makeReplayServerConfig("stop-process"),
        });
        const threadId = ThreadId.make("stop-process-thread");
        const runtime = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("stop-process-session"),
          modelSelection,
          runtimePolicy,
        });
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy,
        });
        const events: Array<ProviderAdapter.ProviderAdapterV2Event> = [];
        const commandStarted = yield* Deferred.make<void>();
        const firstTerminal = yield* Deferred.make<void>();
        const followupCompleted = yield* Deferred.make<void>();
        yield* runtime.events.pipe(
          Stream.runForEach((event) =>
            Effect.gen(function* () {
              events.push(event);
              if (
                event.type === "turn_item.updated" &&
                event.turnItem.type === "command_execution" &&
                event.turnItem.status === "running"
              )
                yield* Deferred.succeed(commandStarted, undefined);
              if (event.type === "turn.terminal" && event.status === "completed")
                yield* Deferred.succeed(followupCompleted, undefined);
              if (event.type === "turn.terminal" && event.status === "interrupted")
                yield* Deferred.succeed(firstTerminal, undefined);
            }),
          ),
          Effect.forkScoped,
        );
        const input = (ordinal: number) =>
          Effect.gen(function* () {
            const now = yield* DateTime.now;
            const appThread: OrchestrationV2AppThread = {
              id: threadId,
              projectId: ProjectId.make("stop-process-project"),
              title: "Stop process",
              createdBy: "user",
              creationSource: "web",
              providerInstanceId: instanceId,
              modelSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: cwd,
              activeProviderThreadId: providerThread.id,
              lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
              forkedFrom: null,
              createdAt: now,
              updatedAt: now,
              archivedAt: null,
              settledOverride: null,
              settledAt: null,
              lastVisitedAt: null,
              deletedAt: null,
            };
            return {
              appThread,
              threadId,
              providerThread,
              runId: RunId.make(`stop-process-run-${ordinal}`),
              runOrdinal: ordinal,
              providerTurnOrdinal: ordinal,
              attemptId: RunAttemptId.make(`stop-process-attempt-${ordinal}`),
              rootNodeId: NodeId.make(`stop-process-node-${ordinal}`),
              modelSelection,
              runtimePolicy,
              message: {
                createdBy: "user",
                creationSource: "web",
                messageId: MessageId.make(`stop-message-${ordinal}`),
                text: "Run the foreground fixture.",
                attachments: [],
              },
            } satisfies ProviderAdapter.ProviderAdapterV2TurnInput;
          });
        yield* runtime.startTurn(yield* input(1));
        yield* Deferred.await(commandStarted);
        assert.equal(yield* fs.readFileString(path.join(cwd, "foreground-start")), "START\n");
        const providerTurn = events.find((event) => event.type === "provider_turn.updated");
        assert.isDefined(providerTurn);
        assert.equal(providerTurn.type, "provider_turn.updated");
        const stop = runtime.interruptTurn({
          providerThread,
          providerTurnId: providerTurn.providerTurn.id,
        });
        if (mode === "retry" || mode === "natural-completion") {
          assert.equal((yield* Effect.exit(stop))._tag, "Failure");
          assert.isTrue(
            yield* runtime.hasPendingBackgroundWork!,
            "Failed containment must retain the live foreground process handle for retry",
          );
          assert.lengthOf(
            events.filter((event) => event.type === "turn.terminal"),
            0,
            "A failed Stop must not claim that the foreground process is interrupted",
          );
        }
        if (mode === "natural-completion") {
          // Stop explicitly failed. When the process then exits naturally, its
          // actual completion must drain the buffered terminal without a retry.
          yield* client.raw.request("fixture/completeForeground", {});
          yield* Deferred.await(firstTerminal);
          assert.equal(yield* fs.readFileString(path.join(cwd, "foreground-finish")), "FINISH\n");
          assert.isFalse(yield* runtime.hasPendingBackgroundWork!);
        } else {
          const stopping = yield* stop.pipe(Effect.forkScoped);
          yield* Deferred.await(terminationPending);
          // The peer sent turn/completed before this barrier. Yield to the FIFO event
          // consumer; no command deadline or wall-clock polling is involved.
          yield* Effect.yieldNow;
          const acknowledgedBeforeContainment = events.some(
            (event) => event.type === "turn.terminal",
          );
          if (acknowledgedBeforeContainment) {
            // Exercise the real mutation after the acknowledgment while containment
            // is held, the deterministic equivalent of the original sleep expiring.
            yield* client.raw.request("fixture/releaseForeground", {});
          }
          yield* client.raw.request("fixture/allowTermination", {});
          yield* Fiber.join(stopping);
          yield* client.raw.request("fixture/releaseForeground", {});
          assert.isFalse(
            yield* fs.exists(path.join(cwd, "foreground-finish")),
            "The foreground process wrote FINISH after Harness acknowledged Stop",
          );
          assert.isFalse(
            acknowledgedBeforeContainment,
            "Stop was acknowledged before process containment",
          );
        }
        assert.deepEqual(
          events.filter((event) => event.type === "turn.terminal").map((event) => event.status),
          ["interrupted"],
        );
        yield* client.raw.request("fixture/releaseUnrelated", {});
        assert.equal(yield* fs.readFileString(path.join(cwd, "unrelated-finish")), "FINISH\n");
        yield* client.raw.request("fixture/lateCompletion", {});
        yield* runtime.startTurn(yield* input(2));
        yield* Deferred.await(followupCompleted);
        assert.deepEqual(
          events.filter((event) => event.type === "turn.terminal").map((event) => event.status),
          ["interrupted", "completed"],
          "Late completion must not resurrect the stopped turn",
        );
        assert.isFalse(yield* runtime.hasPendingBackgroundWork!);
      }),
    ).pipe(
      Effect.provide(
        Layer.mergeAll(NodeServices.layer, IdAllocator.layer, McpProviderSessions.layer),
      ),
    ),
);
