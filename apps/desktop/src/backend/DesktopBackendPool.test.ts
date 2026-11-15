import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as PlatformError from "effect/PlatformError";
import * as TestClock from "effect/testing/TestClock";
import * as DesktopShutdown from "../app/DesktopShutdown.ts";
import { assert, describe, it } from "@effect/vitest";

import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

import * as Queue from "effect/Queue";

import * as FileSystem from "effect/FileSystem";

import * as Layer from "effect/Layer";

import * as Option from "effect/Option";

import * as Ref from "effect/Ref";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/http";
import { ChildProcessSpawner } from "effect/process";

import * as DesktopObservability from "../app/DesktopObservability.ts";
import * as DesktopState from "../app/DesktopState.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";

import * as DesktopTelemetryPublisher from "../telemetry/DesktopTelemetryPublisher.ts";

import * as DesktopBrowserHost from "../preview/DesktopBrowserHost.ts";

import * as ElectronDialog from "../electron/ElectronDialog.ts";

import * as ElectronApp from "../electron/ElectronApp.ts";

import * as DesktopWindow from "../window/DesktopWindow.ts";

import * as DesktopWslEnvironment from "../wsl/DesktopWslEnvironment.ts";

import * as DesktopBackendConfiguration from "./DesktopBackendConfiguration.ts";

import * as DesktopBackendPool from "./DesktopBackendPool.ts";

import type { DesktopBackendStartConfig } from "./DesktopBackendManager.ts";

// Models the spawner's release for a backend that ignores SIGTERM, without OS signals.
const makeFakeBackendProcess = Effect.fn("test.makeFakeBackendProcess")(function* () {
  const started = yield* Deferred.make<void>();
  const exited = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
  const signals = yield* Queue.unbounded<"SIGTERM" | "SIGKILL">();
  let running = false;
  const killWait = Duration.seconds(1);
  const exit = Effect.sync(() => {
    running = false;
  }).pipe(Effect.andThen(Deferred.succeed(exited, ChildProcessSpawner.ExitCode(0))), Effect.asVoid);
  const layer = Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) =>
      Effect.gen(function* () {
        if (command._tag !== "StandardCommand") {
          return yield* Effect.die("Expected a standard backend command");
        }
        const terminateGrace = Duration.fromInputUnsafe(command.options.forceKillAfter ?? 0);
        running = true;
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            yield* Queue.offer(signals, "SIGTERM");
            yield* Effect.sleep(terminateGrace);
            yield* Queue.offer(signals, "SIGKILL");
            yield* Effect.sleep(killWait);
            yield* exit;
          }),
        );
        yield* Deferred.succeed(started, undefined);
        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(123),
          stdout: Stream.empty,
          stderr: Stream.empty,
          all: Stream.empty,
          stdin: Sink.drain,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
          exitCode: Deferred.await(exited),
          isRunning: Effect.sync(() => running),
          kill: () => exit,
          unref: Effect.succeed(Effect.void),
        });
      }),
    ),
  );
  return {
    layer,
    started: Deferred.await(started),
    signals,
    isRunning: Effect.sync(() => running),
    killWait,
  };
});

const runningConfig = {
  executablePath: "/electron",
  args: [],
  entryPath: "/server/bin.mjs",
  cwd: "/server",
  env: {},
  bootstrap: {
    secretStoreKeys: [],
    legacySecretFingerprints: {},
    mode: "desktop",
    noBrowser: true,
    port: 3774,
    t3Home: "/tmp/t3",
    host: "127.0.0.1",
    desktopBootstrapToken: "token",
    tailscaleServeEnabled: false,
    tailscaleServePort: 443,
  },
  bootstrapDelivery: "fd3",
  extendEnv: true,
  httpBaseUrl: new URL("http://127.0.0.1:3774"),
  captureOutput: false,
  preflightFailure: Option.none(),
} satisfies DesktopBackendStartConfig;

function layerPool(
  labelRef: Ref.Ref<string>,
  input: {
    readonly backend?: Effect.Success<ReturnType<typeof makeFakeBackendProcess>>;
    readonly resolvePrimary?: DesktopBackendConfiguration.DesktopBackendConfiguration["Service"]["resolvePrimary"];
    readonly shutdown?: DesktopShutdown.DesktopShutdown["Service"];
    readonly quit?: Effect.Effect<void>;
    readonly showErrorBox?: ElectronDialog.ElectronDialog["Service"]["showErrorBox"];
    readonly spawner?: ChildProcessSpawner.ChildProcessSpawner["Service"];
  } = {},
): Layer.Layer<DesktopBackendPool.DesktopBackendPool> {
  return DesktopBackendPool.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        FileSystem.layerNoop({ exists: () => Effect.succeed(true) }),
        input.backend?.layer ??
          Layer.succeed(
            ChildProcessSpawner.ChildProcessSpawner,
            input.spawner ??
              ChildProcessSpawner.make(() => Effect.die("unexpected child process spawn")),
          ),
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            input.backend === undefined
              ? Effect.die("unexpected HTTP request")
              : Effect.succeed(
                  HttpClientResponse.fromWeb(request, new Response(null, { status: 200 })),
                ),
          ),
        ),
        Layer.succeed(DesktopObservability.DesktopBackendOutputLogFactory, {
          forInstance: () =>
            Effect.succeed({
              beginSession: () => Effect.void,
              writeOutputChunk: () => Effect.void,
              persistFailureSnapshot: () => Effect.void,
              persistFailure: () => Effect.void,
              discardSession: Effect.void,
            } satisfies DesktopObservability.DesktopBackendOutputLogShape),
        } satisfies DesktopObservability.DesktopBackendOutputLogFactory["Service"]),
        Layer.succeed(DesktopTelemetryPublisher.DesktopTelemetryPublisher, {
          latest: Effect.succeedNone,
          changes: Stream.empty,
          encoded: Stream.empty,
          handleControlForSource: () => Effect.void,
          removeControlSource: () => Effect.void,
          publishUpdateReport: () => Effect.void,
          updateRequests: Stream.empty,
          updateCommits: Stream.empty,
          updateCancellations: Stream.empty,
        }),
        DesktopBrowserHost.layer,
        Layer.succeed(DesktopBackendConfiguration.DesktopBackendConfiguration, {
          resolvePrimary: input.resolvePrimary ?? Effect.die("unexpected primary config resolve"),
          resolvePrimaryLabel: Ref.get(labelRef),
          resolveWsl: () => Effect.die("unexpected WSL config resolve"),
          currentBootstrapToken: Effect.die("unexpected bootstrap token read"),
        } satisfies DesktopBackendConfiguration.DesktopBackendConfiguration["Service"]),
        DesktopAppSettings.layerTest(),
        input.shutdown === undefined
          ? DesktopShutdown.layer
          : Layer.succeed(DesktopShutdown.DesktopShutdown, input.shutdown),
        DesktopState.layer,
        DesktopWslEnvironment.layerTest(),
        Layer.succeed(ElectronDialog.ElectronDialog, {
          ...ElectronDialog.make,
          ...(input.showErrorBox === undefined ? {} : { showErrorBox: input.showErrorBox }),
        }),
        Layer.succeed(ElectronApp.ElectronApp, {
          ...ElectronApp.make,
          ...(input.quit === undefined ? {} : { quit: input.quit }),
        }),
        Layer.succeed(DesktopWindow.DesktopWindow, {
          createMain: Effect.die("unexpected window create"),
          ensureMain: Effect.die("unexpected window ensure"),
          revealOrCreateMain: Effect.die("unexpected window reveal"),
          activate: Effect.die("unexpected window activate"),
          createMainIfBackendReady: Effect.die("unexpected window create"),
          showConnectingSplash: Effect.void,
          handleBackendReady: () => Effect.void,
          handleBackendNotReady: Effect.void,
          flushMainWindowBounds: Effect.void,
          prepareCaptureReveal: Effect.void,
          dispatchMenuAction: () => Effect.die("unexpected menu action"),
          dispatchSnapShotEvent: () => Effect.void,
          zoomMain: () => Effect.die("unexpected zoom"),
          runMainContentsCommand: () => Effect.die("unexpected main contents command"),
          syncAppearance: Effect.void,
        } satisfies DesktopWindow.DesktopWindow["Service"]),
      ),
    ),
  );
}

describe("DesktopBackendPool", () => {
  it.effect("unregister during pool quit does not interrupt sibling stops", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = yield* makeFakeBackendProcess();
        yield* Effect.gen(function* () {
          const pool = yield* DesktopBackendPool.DesktopBackendPool;
          const id = DesktopBackendPool.BackendInstanceId("wsl:Ubuntu");
          const ready = yield* Deferred.make<void>();
          const siblingStarted = yield* Deferred.make<void>();
          const finishSibling = yield* Deferred.make<void>();
          let siblingCompleted = false;
          const instance = yield* pool.register({
            id,
            label: Effect.succeed("WSL (Ubuntu)"),
            configResolve: Effect.succeed(runningConfig),
            onReady: () => Deferred.succeed(ready, undefined).pipe(Effect.asVoid),
          });
          yield* instance.start;
          yield* backend.started;
          yield* Deferred.await(ready);
          const quitFiber = yield* Effect.all(
            [
              instance.stop({ timeout: Duration.seconds(5) }),
              Deferred.succeed(siblingStarted, undefined).pipe(
                Effect.andThen(Deferred.await(finishSibling)),
                Effect.andThen(
                  Effect.sync(() => {
                    siblingCompleted = true;
                  }),
                ),
              ),
            ],
            { concurrency: "unbounded" },
          ).pipe(Effect.forkChild);
          yield* Deferred.await(siblingStarted);
          assert.equal(yield* Queue.take(backend.signals), "SIGTERM");
          const unregisterFiber = yield* pool.unregister(id).pipe(Effect.forkChild);
          yield* TestClock.adjust(Duration.seconds(5));
          assert.equal(yield* Queue.take(backend.signals), "SIGKILL");
          assert.isUndefined(quitFiber.pollUnsafe());
          assert.isUndefined(unregisterFiber.pollUnsafe());
          assert.isTrue(yield* backend.isRunning);
          yield* TestClock.adjust(backend.killWait);
          yield* Fiber.join(unregisterFiber);
          yield* Deferred.succeed(finishSibling, undefined);
          yield* Fiber.join(quitFiber);

          assert.isTrue(siblingCompleted);
          assert.isFalse(yield* backend.isRunning);
          assert.isTrue(Option.isNone((yield* instance.snapshot).activePid));
          assert.isTrue(Option.isNone(yield* pool.get(id)));
        }).pipe(Effect.provide(layerPool(Ref.makeUnsafe("Windows"), { backend })));
      }),
    ),
  );

  it.effect("unregister stops the registered instance", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const id = DesktopBackendPool.BackendInstanceId("wsl:Ubuntu");
        const pool = yield* DesktopBackendPool.DesktopBackendPool;
        const instance = yield* pool.register({
          id,
          label: Effect.succeed("WSL (Ubuntu)"),
          configResolve: Effect.succeed({
            ...runningConfig,
            preflightFailure: Option.some({ reason: "WSL starting", fatal: false }),
          }),
        });
        yield* instance.start;
        assert.equal((yield* instance.snapshot).restartScheduled, true);

        yield* pool.unregister(id);

        const stopped = yield* instance.snapshot;
        assert.equal(stopped.desiredRunning, false);
        assert.equal(stopped.restartScheduled, false);
        assert.equal(Option.isNone(yield* pool.get(id)), true);
      }).pipe(Effect.provide(layerPool(Ref.makeUnsafe("Windows")))),
    ),
  );

  // regression: #427 fix: preserve migration activity, native file stashes and fatal shutdown
  it.effect("quits after acknowledging three pre-server failures and completes cleanup", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const shutdown = yield* DesktopShutdown.DesktopShutdown;
        const dialogShown = yield* Deferred.make<{
          readonly title: string;
          readonly content: string;
        }>();
        const acknowledgeDialog = yield* Deferred.make<void>();
        const attempts = yield* Ref.make(0);
        let quitRequests = 0;
        let spawnAttempts = 0;
        let cleanupCompleted = false;
        const failure = PlatformError.systemError({
          _tag: "PermissionDenied",
          module: "DesktopSecretStoreKey",
          method: "decrypt",
          description: "Synthetic pre-server configuration failure",
        });

        yield* Effect.gen(function* () {
          const pool = yield* DesktopBackendPool.DesktopBackendPool;
          const primary = yield* pool.primary;
          // The fatal callback must release its permit before public stop can complete.
          const consumer = yield* Effect.scoped(
            Effect.gen(function* () {
              yield* Effect.addFinalizer(() =>
                primary.stop().pipe(
                  Effect.andThen(
                    Effect.sync(() => {
                      cleanupCompleted = true;
                    }),
                  ),
                  Effect.ensuring(shutdown.markComplete),
                ),
              );
              yield* shutdown.awaitRequest;
            }),
          ).pipe(Effect.forkScoped);

          yield* primary.start;
          yield* TestClock.adjust("500 millis");
          yield* TestClock.adjust("1 second");
          const dialog = yield* Deferred.await(dialogShown);
          assert.equal(yield* Ref.get(attempts), 3);
          assert.match(dialog.title, /couldn't start/);
          assert.match(dialog.content, /failed 3 times/);
          assert.equal(quitRequests, 0, "wait for the fatal dialog acknowledgment");
          assert.isFalse(cleanupCompleted);

          yield* Deferred.succeed(acknowledgeDialog, undefined);
          yield* Fiber.join(consumer);
          yield* TestClock.adjust("30 seconds");
          assert.isTrue(
            cleanupCompleted,
            "the callback must release the backend permit for cleanup",
          );
          assert.isTrue(yield* shutdown.isComplete);
          assert.equal(yield* Ref.get(attempts), 3, "no retry after the fatal failure");
          assert.equal(spawnAttempts, 0, "configuration failure must prevent backend spawn");
          const stopped = yield* primary.snapshot;
          assert.isFalse(stopped.desiredRunning);
          assert.isFalse(stopped.restartScheduled);
          assert.isTrue(Option.isNone(stopped.activePid));
          assert.equal(quitRequests, 1, "acknowledging the fatal error must request Electron quit");
        }).pipe(
          Effect.provide(
            layerPool(Ref.makeUnsafe("Windows"), {
              shutdown,
              resolvePrimary: Ref.updateAndGet(attempts, (count) => count + 1).pipe(
                Effect.andThen(Effect.fail(failure)),
              ),
              showErrorBox: (title, content) =>
                Deferred.succeed(dialogShown, { title, content }).pipe(
                  Effect.andThen(Deferred.await(acknowledgeDialog)),
                ),
              quit: Effect.sync(() => {
                quitRequests += 1;
              }),
              spawner: ChildProcessSpawner.make(() =>
                Effect.sync(() => {
                  spawnAttempts += 1;
                }).pipe(Effect.andThen(Effect.die("unexpected backend spawn"))),
              ),
            }),
          ),
        );
      }).pipe(Effect.provide(Layer.mergeAll(DesktopShutdown.layer, TestClock.layer()))),
    ),
  );
});
