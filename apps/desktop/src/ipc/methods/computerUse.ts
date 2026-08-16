import { DesktopComputerUseStateSchema } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopLifecycle from "../../app/DesktopLifecycle.ts";
import * as DesktopComputerUse from "../../computerUse/DesktopComputerUse.ts";
import * as DesktopAppSettings from "../../settings/DesktopAppSettings.ts";
import * as IpcChannels from "../channels.ts";
import { makeIpcMethod } from "../DesktopIpc.ts";

const readComputerUseState = Effect.gen(function* () {
  const appSettings = yield* DesktopAppSettings.DesktopAppSettings;
  const computerUse = yield* DesktopComputerUse.DesktopComputerUse;
  const settings = yield* appSettings.get;
  return yield* computerUse.getState(settings.computerUseEnabled);
});

export const getComputerUseState = makeIpcMethod({
  channel: IpcChannels.GET_COMPUTER_USE_STATE_CHANNEL,
  payload: Schema.Void,
  result: DesktopComputerUseStateSchema,
  handler: Effect.fn("desktop.ipc.computerUse.getState")(function* () {
    return yield* readComputerUseState;
  }),
});

export const setComputerUseEnabled = makeIpcMethod({
  channel: IpcChannels.SET_COMPUTER_USE_ENABLED_CHANNEL,
  payload: Schema.Boolean,
  result: DesktopComputerUseStateSchema,
  handler: Effect.fn("desktop.ipc.computerUse.setEnabled")(function* (enabled) {
    const appSettings = yield* DesktopAppSettings.DesktopAppSettings;
    const computerUse = yield* DesktopComputerUse.DesktopComputerUse;
    const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
    const currentState = yield* readComputerUseState;

    if (enabled && currentState.available) {
      yield* computerUse.requestPermissions;
    }

    const change = yield* appSettings.setComputerUseEnabled(enabled);
    const state = yield* readComputerUseState;
    const permissionsReady =
      state.accessibilityPermission !== false && state.screenRecordingPermission !== false;

    if (change.changed && (!enabled || (state.available && permissionsReady))) {
      yield* lifecycle.relaunch(`computerUseEnabled=${enabled}`, { waitForIpcResponse: true });
    }

    return state;
  }),
});
