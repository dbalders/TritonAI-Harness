import { DesktopComputerUseStateSchema } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as DesktopLifecycle from "../../app/DesktopLifecycle.ts";
import * as DesktopShutdown from "../../app/DesktopShutdown.ts";
import * as DesktopState from "../../app/DesktopState.ts";
import * as DesktopComputerUse from "../../computerUse/DesktopComputerUse.ts";
import * as ElectronApp from "../../electron/ElectronApp.ts";
import * as ElectronTheme from "../../electron/ElectronTheme.ts";
import * as DesktopAppSettings from "../../settings/DesktopAppSettings.ts";
import * as DesktopWindow from "../../window/DesktopWindow.ts";
import { setComputerUseEnabled } from "./computerUse.ts";

const decodeComputerUseState = Schema.decodeUnknownEffect(DesktopComputerUseStateSchema);

const invokeSetComputerUseEnabled = (enabled: boolean) =>
  setComputerUseEnabled.handler(enabled).pipe(Effect.flatMap(decodeComputerUseState));

function makeLifecycleLayer(relaunches: Array<{ reason: string; waitForIpcResponse: boolean }>) {
  return Layer.succeed(
    DesktopLifecycle.DesktopLifecycle,
    DesktopLifecycle.DesktopLifecycle.of({
      relaunch: (reason, options) =>
        Effect.sync(() => {
          relaunches.push({
            reason,
            waitForIpcResponse: options?.waitForIpcResponse === true,
          });
        }),
      register: Effect.void,
    }),
  );
}

const unusedLifecycleRuntimeLayer = Layer.mergeAll(
  DesktopShutdown.layer,
  DesktopState.layer,
  Layer.succeed(
    DesktopEnvironment.DesktopEnvironment,
    DesktopEnvironment.DesktopEnvironment.of(
      {} as DesktopEnvironment.DesktopEnvironment["Service"],
    ),
  ),
  Layer.succeed(
    DesktopWindow.DesktopWindow,
    DesktopWindow.DesktopWindow.of({} as DesktopWindow.DesktopWindow["Service"]),
  ),
  Layer.succeed(
    ElectronApp.ElectronApp,
    ElectronApp.ElectronApp.of({} as ElectronApp.ElectronApp["Service"]),
  ),
  Layer.succeed(
    ElectronTheme.ElectronTheme,
    ElectronTheme.ElectronTheme.of({} as ElectronTheme.ElectronTheme["Service"]),
  ),
);

describe("computer use IPC", () => {
  it.effect("requests permissions and relaunches after an available opt-in", () => {
    let permissionRequests = 0;
    const relaunches: Array<{ reason: string; waitForIpcResponse: boolean }> = [];
    const layer = Layer.mergeAll(
      DesktopAppSettings.layerTest(),
      DesktopComputerUse.layerTest({
        state: {
          available: true,
          accessibilityPermission: true,
          screenRecordingPermission: true,
        },
        onRequestPermissions: Effect.sync(() => {
          permissionRequests += 1;
        }),
      }),
      makeLifecycleLayer(relaunches),
      unusedLifecycleRuntimeLayer,
    );

    return Effect.gen(function* () {
      const state = yield* invokeSetComputerUseEnabled(true);

      assert.equal(state.enabled, true);
      assert.equal(permissionRequests, 1);
      assert.deepEqual(relaunches, [
        { reason: "computerUseEnabled=true", waitForIpcResponse: true },
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("persists opt-in without relaunching while macOS permissions are missing", () => {
    let permissionRequests = 0;
    const relaunches: Array<{ reason: string; waitForIpcResponse: boolean }> = [];
    const layer = Layer.mergeAll(
      DesktopAppSettings.layerTest(),
      DesktopComputerUse.layerTest({
        state: {
          available: true,
          accessibilityPermission: false,
          screenRecordingPermission: false,
        },
        onRequestPermissions: Effect.sync(() => {
          permissionRequests += 1;
        }),
      }),
      makeLifecycleLayer(relaunches),
      unusedLifecycleRuntimeLayer,
    );

    return Effect.gen(function* () {
      const state = yield* invokeSetComputerUseEnabled(true);

      assert.equal(state.enabled, true);
      assert.equal(permissionRequests, 1);
      assert.deepEqual(relaunches, []);
    }).pipe(Effect.provide(layer));
  });

  it.effect("relaunches to remove an active driver when the user opts out", () => {
    let permissionRequests = 0;
    const relaunches: Array<{ reason: string; waitForIpcResponse: boolean }> = [];
    const layer = Layer.mergeAll(
      DesktopAppSettings.layerTest({
        ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
        computerUseEnabled: true,
      }),
      DesktopComputerUse.layerTest({
        state: { available: true, running: true },
        onRequestPermissions: Effect.sync(() => {
          permissionRequests += 1;
        }),
      }),
      makeLifecycleLayer(relaunches),
      unusedLifecycleRuntimeLayer,
    );

    return Effect.gen(function* () {
      const state = yield* invokeSetComputerUseEnabled(false);

      assert.equal(state.enabled, false);
      assert.equal(permissionRequests, 0);
      assert.deepEqual(relaunches, [
        { reason: "computerUseEnabled=false", waitForIpcResponse: true },
      ]);
    }).pipe(Effect.provide(layer));
  });
});
