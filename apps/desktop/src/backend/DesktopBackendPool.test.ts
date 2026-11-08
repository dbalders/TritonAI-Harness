import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient } from "effect/http";
import { ChildProcessSpawner } from "effect/process";

import * as DesktopObservability from "../app/DesktopObservability.ts";
import * as DesktopShutdown from "../app/DesktopShutdown.ts";
import { stopAllPoolInstances } from "../app/DesktopApp.ts";
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

function layerPool(
  labelRef: Ref.Ref<string>,
  input: {
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
        FileSystem.layerNoop({}),
        Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          input.spawner ??
            ChildProcessSpawner.make(() => Effect.die("unexpected child process spawn")),
        ),
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make(() => Effect.die("unexpected HTTP request")),
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
          // Exercise the exported app cleanup seam and its real shutdown signal.
          const consumer = yield* Effect.scoped(
            Effect.gen(function* () {
              yield* Effect.addFinalizer(() =>
                stopAllPoolInstances().pipe(
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

  it.effect("resolves the primary label lazily after pool layer construction", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const labelRef = yield* Ref.make("Windows");
        const pool = yield* DesktopBackendPool.DesktopBackendPool.pipe(
          Effect.provide(layerPool(labelRef)),
        );
        const primary = yield* pool.primary;

        yield* Ref.set(labelRef, "WSL (Ubuntu)");

        assert.equal(yield* primary.label, "WSL (Ubuntu)");
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
          // A transient preflight failure leaves a restart fiber scheduled
          // without needing a real child process.
          configResolve: Effect.succeed({
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
            preflightFailure: Option.some({ reason: "WSL starting", fatal: false }),
          } satisfies DesktopBackendStartConfig),
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
});
