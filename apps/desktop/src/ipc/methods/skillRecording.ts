import {
  DesktopSkillRecordingStartResult,
  DesktopSkillRecordingStopResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopSkillRecording from "../../skillRecording/DesktopSkillRecording.ts";
import * as IpcChannels from "../channels.ts";
import { makeIpcMethod } from "../DesktopIpc.ts";

// Recordings belong to the window that started them; -1 never matches one.
const ownerOf = (event: { readonly sender: { readonly id: number } } | undefined) =>
  event?.sender.id ?? -1;

export const requestSkillRecordingPermission = makeIpcMethod({
  channel: IpcChannels.REQUEST_SKILL_RECORDING_PERMISSION_CHANNEL,
  payload: Schema.Void,
  result: Schema.Boolean,
  handler: Effect.fn("desktop.ipc.skillRecording.requestPermission")(function* () {
    const recording = yield* DesktopSkillRecording.DesktopSkillRecording;
    return yield* recording.requestPermission;
  }),
});

export const startSkillRecording = makeIpcMethod({
  channel: IpcChannels.START_SKILL_RECORDING_CHANNEL,
  payload: Schema.Void,
  result: DesktopSkillRecordingStartResult,
  handler: Effect.fn("desktop.ipc.skillRecording.start")(function* (_, event) {
    const recording = yield* DesktopSkillRecording.DesktopSkillRecording;
    return yield* recording.start(ownerOf(event));
  }),
});

export const stopSkillRecording = makeIpcMethod({
  channel: IpcChannels.STOP_SKILL_RECORDING_CHANNEL,
  payload: Schema.String,
  result: DesktopSkillRecordingStopResult,
  handler: Effect.fn("desktop.ipc.skillRecording.stop")(function* (sessionId, event) {
    const recording = yield* DesktopSkillRecording.DesktopSkillRecording;
    return yield* recording.stop(sessionId, ownerOf(event));
  }),
});

export const cancelSkillRecording = makeIpcMethod({
  channel: IpcChannels.CANCEL_SKILL_RECORDING_CHANNEL,
  payload: Schema.String,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.skillRecording.cancel")(function* (sessionId, event) {
    const recording = yield* DesktopSkillRecording.DesktopSkillRecording;
    yield* recording.cancel(sessionId, ownerOf(event));
  }),
});
