import {
  DesktopUpdateActionResultSchema,
  DesktopUpdateChannelSchema,
  DesktopUpdateCheckResultSchema,
  DesktopUpdateStateSchema,
  InstallerUpdateActionResultSchema,
  InstallerUpdateCheckResultSchema,
  InstallerUpdateStateSchema,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopUpdates from "../../updates/DesktopUpdates.ts";
import * as InstallerUpdates from "../../updates/InstallerUpdates.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

export const getUpdateState = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.UPDATE_GET_STATE_CHANNEL,
  payload: Schema.Void,
  result: DesktopUpdateStateSchema,
  handler: Effect.fn("desktop.ipc.updates.getState")(function* () {
    const updates = yield* DesktopUpdates.DesktopUpdates;
    return yield* updates.getState;
  }),
});

export const setUpdateChannel = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.UPDATE_SET_CHANNEL_CHANNEL,
  payload: DesktopUpdateChannelSchema,
  result: DesktopUpdateStateSchema,
  handler: Effect.fn("desktop.ipc.updates.setChannel")(function* (channel) {
    const updates = yield* DesktopUpdates.DesktopUpdates;
    return yield* updates.setChannel(channel);
  }),
});

export const downloadUpdate = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.UPDATE_DOWNLOAD_CHANNEL,
  payload: Schema.Void,
  result: DesktopUpdateActionResultSchema,
  handler: Effect.fn("desktop.ipc.updates.download")(function* () {
    const updates = yield* DesktopUpdates.DesktopUpdates;
    return yield* updates.download;
  }),
});

export const installUpdate = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.UPDATE_INSTALL_CHANNEL,
  payload: Schema.Void,
  result: DesktopUpdateActionResultSchema,
  handler: Effect.fn("desktop.ipc.updates.install")(function* () {
    const updates = yield* DesktopUpdates.DesktopUpdates;
    return yield* updates.install;
  }),
});

export const checkForUpdate = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.UPDATE_CHECK_CHANNEL,
  payload: Schema.Void,
  result: DesktopUpdateCheckResultSchema,
  handler: Effect.fn("desktop.ipc.updates.check")(function* () {
    const updates = yield* DesktopUpdates.DesktopUpdates;
    return yield* updates.check("web-ui");
  }),
});

export const getInstallerUpdateState = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.INSTALLER_UPDATE_GET_STATE_CHANNEL,
  payload: Schema.Void,
  result: InstallerUpdateStateSchema,
  handler: Effect.fn("desktop.ipc.installerUpdates.getState")(function* () {
    const updates = yield* InstallerUpdates.InstallerUpdates;
    return yield* updates.getState;
  }),
});

export const checkInstallerUpdate = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.INSTALLER_UPDATE_CHECK_CHANNEL,
  payload: Schema.Void,
  result: InstallerUpdateCheckResultSchema,
  handler: Effect.fn("desktop.ipc.installerUpdates.check")(function* () {
    const updates = yield* InstallerUpdates.InstallerUpdates;
    return yield* updates.check;
  }),
});

export const openInstallerUpdate = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.INSTALLER_UPDATE_OPEN_CHANNEL,
  payload: Schema.Void,
  result: InstallerUpdateActionResultSchema,
  handler: Effect.fn("desktop.ipc.installerUpdates.open")(function* () {
    const updates = yield* InstallerUpdates.InstallerUpdates;
    return yield* updates.open;
  }),
});
