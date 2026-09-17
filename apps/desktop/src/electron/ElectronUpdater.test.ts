import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { beforeEach, vi } from "vite-plus/test";

const { autoUpdaterMock, nativeUpdaterMock, MacUpdaterMock } = await vi.hoisted(async () => {
  const { EventEmitter } = await import("node:events");
  return {
    nativeUpdaterMock: new EventEmitter(),
    // oxlint-disable-next-line typescript/no-extraneous-class -- Models electron-updater's platform class for instanceof.
    MacUpdaterMock: class {},
    autoUpdaterMock: {
      allowDowngrade: false,
      allowPrerelease: false,
      autoDownload: true,
      autoInstallOnAppQuit: true,
      channel: "latest",
      disableDifferentialDownload: false,
      fullChangelog: false,
      checkForUpdates: vi.fn(() => Promise.resolve(null)),
      downloadUpdate: vi.fn(() => Promise.resolve([])),
      on: vi.fn(),
      quitAndInstall: vi.fn(),
      removeListener: vi.fn(),
      setFeedURL: vi.fn(),
    },
  };
});

vi.mock("electron-updater", () => ({
  autoUpdater: autoUpdaterMock,
  MacUpdater: MacUpdaterMock,
}));
vi.mock("electron", () => ({ autoUpdater: nativeUpdaterMock }));

import * as ElectronUpdater from "./ElectronUpdater.ts";

describe("ElectronUpdater", () => {
  beforeEach(() => {
    autoUpdaterMock.allowDowngrade = false;
    autoUpdaterMock.allowPrerelease = false;
    autoUpdaterMock.autoDownload = true;
    autoUpdaterMock.autoInstallOnAppQuit = true;
    autoUpdaterMock.channel = "latest";
    autoUpdaterMock.disableDifferentialDownload = false;
    autoUpdaterMock.fullChangelog = false;
    autoUpdaterMock.checkForUpdates.mockClear();
    autoUpdaterMock.checkForUpdates.mockImplementation(() => Promise.resolve(null));
    autoUpdaterMock.downloadUpdate.mockClear();
    autoUpdaterMock.downloadUpdate.mockImplementation(() => Promise.resolve([]));
    autoUpdaterMock.on.mockClear();
    autoUpdaterMock.quitAndInstall.mockClear();
    autoUpdaterMock.removeListener.mockClear();
    autoUpdaterMock.setFeedURL.mockClear();
    Object.setPrototypeOf(autoUpdaterMock, Object.prototype);
    nativeUpdaterMock.removeAllListeners();
  });

  it.effect("scopes updater event listeners", () =>
    Effect.gen(function* () {
      const listener = vi.fn();

      yield* Effect.scoped(
        Effect.gen(function* () {
          const updater = yield* ElectronUpdater.ElectronUpdater;
          yield* updater.on("update-available", listener);
        }),
      );

      assert.deepEqual(autoUpdaterMock.on.mock.calls, [["update-available", listener]]);
      assert.deepEqual(autoUpdaterMock.removeListener.mock.calls, [["update-available", listener]]);
    }).pipe(Effect.provide(ElectronUpdater.layer)),
  );

  it.effect("wraps rejected update checks in the method-specific typed error", () =>
    Effect.gen(function* () {
      const cause = new Error("network unavailable");
      autoUpdaterMock.checkForUpdates.mockImplementationOnce(() => Promise.reject(cause));
      const updater = yield* ElectronUpdater.ElectronUpdater;
      autoUpdaterMock.channel = "beta";

      const error = yield* updater.checkForUpdates.pipe(Effect.flip);

      assert.instanceOf(error, ElectronUpdater.ElectronUpdaterCheckForUpdatesError);
      assert.isTrue(ElectronUpdater.isElectronUpdaterError(error));
      assert.equal(error.channel, "beta");
      assert.strictEqual(error.cause, cause);
      assert.equal(error.message, "Electron updater failed to check for updates on channel beta.");
      assert.notInclude(error.message, cause.message);
    }).pipe(Effect.provide(ElectronUpdater.layer)),
  );

  it.effect("preserves the execution-time channel on download failures", () =>
    Effect.gen(function* () {
      const cause = new Error("download unavailable");
      autoUpdaterMock.downloadUpdate.mockImplementationOnce(() => Promise.reject(cause));
      const updater = yield* ElectronUpdater.ElectronUpdater;
      autoUpdaterMock.channel = "nightly";

      const error = yield* updater.downloadUpdate.pipe(Effect.flip);

      assert.instanceOf(error, ElectronUpdater.ElectronUpdaterDownloadUpdateError);
      assert.isTrue(ElectronUpdater.isElectronUpdaterError(error));
      assert.equal(error.channel, "nightly");
      assert.strictEqual(error.cause, cause);
      assert.equal(
        error.message,
        "Electron updater failed to download the update on channel nightly.",
      );
      assert.notInclude(error.message, cause.message);
    }).pipe(Effect.provide(ElectronUpdater.layer)),
  );

  it.effect("sets full changelog mode", () =>
    Effect.gen(function* () {
      const updater = yield* ElectronUpdater.ElectronUpdater;

      yield* updater.setFullChangelog(true);
      assert.equal(autoUpdaterMock.fullChangelog, true);

      yield* updater.setFullChangelog(false);
      assert.equal(autoUpdaterMock.fullChangelog, false);
    }).pipe(Effect.provide(ElectronUpdater.layer)),
  );

  it.effect("keeps macOS download pending until native validation succeeds", () =>
    Effect.gen(function* () {
      Object.setPrototypeOf(autoUpdaterMock, MacUpdaterMock.prototype);
      let downloadFinished = false;
      const transferred = Promise.withResolvers<void>();
      autoUpdaterMock.downloadUpdate.mockImplementationOnce(async () => {
        assert.equal(nativeUpdaterMock.listenerCount("update-downloaded"), 1);
        transferred.resolve();
        return [];
      });
      const updater = yield* ElectronUpdater.ElectronUpdater;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const result = yield* updater.downloadUpdate.pipe(
            Effect.andThen(
              Effect.sync(() => {
                downloadFinished = true;
              }),
            ),
            Effect.forkScoped,
          );
          yield* Effect.promise(() => transferred.promise);
          assert.isFalse(downloadFinished);
          nativeUpdaterMock.emit("update-downloaded");
          yield* Fiber.join(result);
          assert.isTrue(downloadFinished);
          assert.equal(nativeUpdaterMock.listenerCount("update-downloaded"), 0);
          assert.equal(nativeUpdaterMock.listenerCount("error"), 0);
        }),
      );
    }).pipe(Effect.provide(ElectronUpdater.layer)),
  );

  it.effect("rejects a ZIP that native validation rejects after transfer", () =>
    Effect.gen(function* () {
      Object.setPrototypeOf(autoUpdaterMock, MacUpdaterMock.prototype);
      const cause = new Error("signature rejected");
      autoUpdaterMock.downloadUpdate.mockImplementationOnce(async () => {
        queueMicrotask(() => nativeUpdaterMock.emit("error", cause));
        return [];
      });
      const updater = yield* ElectronUpdater.ElectronUpdater;
      const error = yield* updater.downloadUpdate.pipe(Effect.flip);
      assert.strictEqual(error.cause, cause);
      assert.equal(nativeUpdaterMock.listenerCount("update-downloaded"), 0);
      assert.equal(nativeUpdaterMock.listenerCount("error"), 0);
    }).pipe(Effect.provide(ElectronUpdater.layer)),
  );

  it.effect("announces macOS readiness only after Squirrel validates the matching transfer", () =>
    Effect.gen(function* () {
      Object.setPrototypeOf(autoUpdaterMock, MacUpdaterMock.prototype);
      const listener = vi.fn();
      yield* Effect.scoped(
        Effect.gen(function* () {
          const updater = yield* ElectronUpdater.ElectronUpdater;
          yield* updater.on("update-downloaded", listener);
          const receive = autoUpdaterMock.on.mock.calls.at(-1)?.[1] as (...args: unknown[]) => void;
          receive({ version: "1.2.4" });
          assert.equal(listener.mock.calls.length, 0);
          nativeUpdaterMock.emit("error", new Error("invalid ZIP"));
          nativeUpdaterMock.emit("update-downloaded");
          assert.equal(listener.mock.calls.length, 0);
          receive({ version: "1.2.5" });
          nativeUpdaterMock.emit("update-downloaded");
          assert.deepEqual(listener.mock.calls, [[{ version: "1.2.5" }]]);
        }),
      );
      assert.equal(nativeUpdaterMock.listenerCount("update-downloaded"), 0);
      assert.equal(nativeUpdaterMock.listenerCount("error"), 0);
    }).pipe(Effect.provide(ElectronUpdater.layer)),
  );

  it.effect("preserves quit-and-install flags and the execution-time channel", () =>
    Effect.gen(function* () {
      const cause = new Error("quit and install failed");
      autoUpdaterMock.quitAndInstall.mockImplementationOnce(() => {
        throw cause;
      });
      const updater = yield* ElectronUpdater.ElectronUpdater;
      autoUpdaterMock.channel = "alpha";

      const error = yield* updater
        .quitAndInstall({ isSilent: true, isForceRunAfter: false })
        .pipe(Effect.flip);

      assert.instanceOf(error, ElectronUpdater.ElectronUpdaterQuitAndInstallError);
      assert.isTrue(ElectronUpdater.isElectronUpdaterError(error));
      assert.equal(error.channel, "alpha");
      assert.equal(error.isSilent, true);
      assert.equal(error.isForceRunAfter, false);
      assert.strictEqual(error.cause, cause);
      assert.equal(
        error.message,
        "Electron updater failed to quit and install the update on channel alpha (silent: true, force run after: false).",
      );
      assert.notInclude(error.message, cause.message);
      assert.deepEqual(autoUpdaterMock.quitAndInstall.mock.calls, [[true, false]]);
    }).pipe(Effect.provide(ElectronUpdater.layer)),
  );
});
