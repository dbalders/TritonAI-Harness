import { assert, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
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
import {
  CodexAppServerProcessExitedError,
  CodexAppServerInputStreamEndedError,
  CodexAppServerTransportError,
} from "effect-codex-app-server/errors";
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
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as CodexAdapterV2 from "./CodexAdapterV2.ts";
import { makeReplayServerConfig } from "./CodexAdapterV2.testkit.ts";

vi.mock("effect/Semaphore", { spy: true });

const defaultCodexSettings = Schema.decodeSync(CodexSettings)({});

const PermitRaceActor = Context.Reference<"completion" | "stop" | undefined>("stop-test/actor", {
  defaultValue: () => undefined,
});

// regression: #421 contain Stop commands and restore managed Auto approvals
it.live.each([
  "success",
  "retry",
  "missing-ack",
  "natural-completion",
  "completion-waits-for-permit",
  "stop-claims-after-snapshot",
  "null-process-id",
  "null-retry",
  "null-late-registration",
  "null-late-item",
  "null-duplicate-start",
  "null-duplicate-provenance",
  "null-no-match",
  "null-missing-attribution",
  "null-ambiguous",
  "null-verify-present",
  "null-unloaded-initial",
  "null-unloaded-settled",
  "null-unloaded-terminate",
  "null-exited-terminate",
  "null-input-ended-verify",
  "null-generic-transport",
  "null-unknown-rpc",
] as const)(
  "withholds Stop acknowledgment until the owned foreground process is contained (%s)",
  (mode) =>
    Effect.scoped(
      Effect.gen(function* () {
        const barrierReached = yield* Deferred.make<void>();
        const releaseBarrier = yield* Deferred.make<void>();
        const completionHandled = yield* Deferred.make<void>();
        const stopClaimed = yield* Deferred.make<void>();
        const racesCompletion = mode === "completion-waits-for-permit";
        const racesClaim = mode === "stop-claims-after-snapshot";
        if (racesCompletion || racesClaim) {
          // Schedule real adapter operations on opposite sides of a permit
          // boundary. Preserve the actual semaphore, effects and process RPCs;
          // assert the observable terminal/process behavior below.
          const { make: makeSemaphore } = yield* Effect.promise(() =>
            vi.importActual<typeof import("effect/Semaphore")>("effect/Semaphore"),
          );
          let armed = true;
          let stopAcquisitions = 0;
          const spy = vi.spyOn(Semaphore, "make").mockImplementation((permits) =>
            makeSemaphore(permits).pipe(
              Effect.map((semaphore) => {
                const withPermits = semaphore.withPermits.bind(semaphore);
                semaphore.withPermits = (count) => (effect) =>
                  Effect.gen(function* () {
                    const actor = yield* PermitRaceActor;
                    if (armed && racesCompletion && actor === "completion") {
                      armed = false;
                      yield* Deferred.succeed(barrierReached, undefined);
                      yield* Deferred.await(releaseBarrier);
                    }
                    const result = yield* withPermits(count)(effect);
                    // Stop first resolves a goal target, then selects its
                    // active/settled contexts. Pause after the latter releases.
                    if (actor === "stop") stopAcquisitions++;
                    if (armed && racesClaim && actor === "stop" && stopAcquisitions === 2) {
                      armed = false;
                      yield* Deferred.succeed(barrierReached, undefined);
                      yield* Deferred.await(releaseBarrier);
                    }
                    return result;
                  });
                return semaphore;
              }),
            ),
          );
          yield* Effect.addFinalizer(() => Effect.sync(() => spy.mockRestore()));
        }
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
        const nativeClient = Context.get(clientContext, CodexClient.CodexAppServerClient);
        const terminateRequests: unknown[] = [];
        let targetLists = 0;
        let terminationSent = false;
        const conclusiveEnd = mode.includes("-exited-") || mode.includes("-input-ended-");
        const client: CodexClient.CodexAppServerClient["Service"] = {
          ...nativeClient,
          raw: {
            ...nativeClient.raw,
            request: (method, params) =>
              Effect.gen(function* () {
                if (method === "thread/backgroundTerminals/terminate") {
                  terminateRequests.push(params);
                  terminationSent = true;
                }
                if (method === "thread/backgroundTerminals/list") targetLists++;
                if (
                  mode === "null-generic-transport" &&
                  method === "thread/backgroundTerminals/list"
                )
                  return yield* Effect.fail(
                    new CodexAppServerTransportError({
                      operation: "read-input-stream",
                      cause: new Error("unclassified transport failure"),
                    }),
                  );
                const removedHere =
                  conclusiveEnd &&
                  ((mode.endsWith("initial") &&
                    method === "thread/backgroundTerminals/list" &&
                    targetLists === 1) ||
                    (mode.endsWith("terminate") &&
                      method === "thread/backgroundTerminals/terminate") ||
                    (mode.endsWith("verify") &&
                      method === "thread/backgroundTerminals/list" &&
                      terminationSent));
                if (removedHere) {
                  yield* nativeClient.raw.request("fixture/removeOwned", {});
                  return yield* Effect.fail(
                    mode.includes("-exited-")
                      ? new CodexAppServerProcessExitedError({ code: 0 })
                      : new CodexAppServerInputStreamEndedError({}),
                  );
                }
                if (
                  conclusiveEnd &&
                  mode.endsWith("verify") &&
                  method === "thread/backgroundTerminals/terminate"
                ) {
                  yield* nativeClient.raw.request("fixture/removeOwned", {});
                  return { terminated: true };
                }
                return yield* nativeClient.raw.request(method, params);
              }),
          },
          request: (method, params) =>
            (method === "turn/interrupt"
              ? Deferred.succeed(stopClaimed, undefined).pipe(Effect.asVoid)
              : Effect.void
            ).pipe(Effect.andThen(nativeClient.request(method, params))),
          handleServerNotification: (method, handler) =>
            nativeClient.handleServerNotification(method, (payload) =>
              method === "turn/completed"
                ? handler(payload).pipe(
                    Effect.provideService(PermitRaceActor, "completion"),
                    Effect.tap(() => Deferred.succeed(completionHandled, undefined)),
                  )
                : handler(payload),
            ),
        };
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
        const eventFenceObserved = yield* Deferred.make<void>();
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
              if (
                event.type === "provider_thread.updated" &&
                event.providerThread.goal?.objective === "event fence"
              )
                yield* Deferred.succeed(eventFenceObserved, undefined);
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
        if (mode.startsWith("null-")) {
          assert.equal(yield* fs.readFileString(path.join(cwd, "other-thread-start")), "START\n");
          assert.deepEqual(
            yield* nativeClient.raw.request("thread/backgroundTerminals/list", {
              threadId: "other-native-thread",
            }),
            {
              data: [{ itemId: "foreground-command", processId: "other-thread-handle" }],
              nextCursor: null,
            },
          );
        }
        const providerTurn = events.find((event) => event.type === "provider_turn.updated");
        assert.isDefined(providerTurn);
        assert.equal(providerTurn.type, "provider_turn.updated");
        const settledRemoval = mode === "null-unloaded-settled";
        if (settledRemoval) {
          yield* client.raw.request("fixture/normalCompletion", {});
          yield* Deferred.await(followupCompleted);
        }
        const stop = runtime
          .interruptTurn({
            providerThread,
            providerTurnId: providerTurn.providerTurn.id,
            ...(settledRemoval ? { requestRuntimeRestart: true } : {}),
          })
          .pipe(Effect.provideService(PermitRaceActor, "stop"));
        if (mode.startsWith("null-unloaded-") || conclusiveEnd) {
          yield* stop;
          if (!settledRemoval) yield* Deferred.await(firstTerminal);
          assert.isFalse(
            yield* runtime.hasPendingBackgroundWork!,
            "Confirmed removal must drain retained command ownership",
          );
          yield* client.raw.request("fixture/releaseForeground", {});
          assert.isFalse(yield* fs.exists(path.join(cwd, "foreground-finish")));
          yield* client.raw.request("fixture/releaseUnrelated", {});
          assert.equal(yield* fs.readFileString(path.join(cwd, "unrelated-finish")), "FINISH\n");
          assert.equal(yield* fs.readFileString(path.join(cwd, "other-thread-finish")), "FINISH\n");
          assert.lengthOf(
            events.filter((event) => event.type === "turn.terminal"),
            1,
          );
          return;
        }
        const unresolvedOwnership = [
          "null-no-match",
          "null-missing-attribution",
          "null-ambiguous",
          "null-verify-present",
          "null-duplicate-provenance",
          "null-generic-transport",
          "null-unknown-rpc",
        ].includes(mode);
        if (
          mode === "retry" ||
          mode === "natural-completion" ||
          mode === "null-retry" ||
          unresolvedOwnership
        ) {
          assert.equal((yield* Effect.exit(stop))._tag, "Failure");
          if (
            [
              "null-no-match",
              "null-missing-attribution",
              "null-ambiguous",
              "null-generic-transport",
              "null-unknown-rpc",
            ].includes(mode)
          ) {
            assert.lengthOf(
              terminateRequests,
              0,
              "Unattributed or unknown failures must send ZERO terminate RPCs",
            );
            assert.isFalse(yield* fs.exists(path.join(cwd, "terminate-attempts")));
          }
          if (mode === "null-duplicate-provenance") {
            yield* client.raw.request("fixture/eventFence", {});
            yield* Deferred.await(eventFenceObserved);
            assert.equal(
              (yield* Effect.exit(stop))._tag,
              "Failure",
              "A duplicate null-ID start must retain registry absence verification on retry",
            );
          }
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
        if (mode === "natural-completion" || unresolvedOwnership) {
          // Stop explicitly failed. When the process then exits naturally, its
          // actual completion must drain the buffered terminal without a retry.
          // A duplicate native completion with no Stop waiter must return even
          // while the owned command is still live (no reentrant drain permit).
          yield* client.raw.request("fixture/normalCompletion", {});
          assert.lengthOf(
            events.filter((event) => event.type === "turn.terminal"),
            0,
          );
          yield* client.raw.request("fixture/completeForeground", {});
          yield* Deferred.await(firstTerminal);
          assert.equal(yield* fs.readFileString(path.join(cwd, "foreground-finish")), "FINISH\n");
          assert.isFalse(yield* runtime.hasPendingBackgroundWork!);
        } else {
          const completionRequest = racesCompletion
            ? yield* client.raw.request("fixture/normalCompletion", {}).pipe(Effect.forkScoped)
            : undefined;
          if (racesCompletion) yield* Deferred.await(barrierReached);
          const stopping = yield* stop.pipe(Effect.forkScoped);
          if (racesCompletion) {
            yield* Deferred.await(stopClaimed);
            yield* Deferred.succeed(releaseBarrier, undefined);
            yield* Deferred.await(completionHandled);
            if (completionRequest !== undefined) yield* Fiber.join(completionRequest);
          }
          if (racesClaim) {
            yield* Deferred.await(barrierReached);
            yield* client.raw.request("fixture/normalCompletion", {});
            yield* Deferred.await(completionHandled);
            yield* Deferred.succeed(releaseBarrier, undefined);
          }
          yield* Deferred.await(terminationPending);
          // This inert paused goal projects a provider-thread marker
          // even if completion already settled the context. Its observation
          // drains all preceding events through the same FIFO consumer.
          yield* client.raw.request("fixture/eventFence", {});
          yield* Deferred.await(eventFenceObserved);
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
          if (mode === "null-late-item")
            assert.isFalse(
              yield* fs.exists(path.join(cwd, "late-finish")),
              "Late null-ID command escaped containment",
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
        if (mode.startsWith("null-"))
          assert.equal(yield* fs.readFileString(path.join(cwd, "other-thread-finish")), "FINISH\n");
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
