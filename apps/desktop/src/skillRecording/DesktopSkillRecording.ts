import type {
  DesktopSkillRecordingStartResult,
  DesktopSkillRecordingStopResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Electron from "electron";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { SKILL_RECORDING_CONTROL_CHANNEL } from "../ipc/channels.ts";
import { makeSkillRecordingBar, type SkillRecordingBarAction } from "./SkillRecordingBar.ts";
import { startSkillRecordingProcess } from "./SkillRecordingProcess.ts";
import { type ActiveRecording, makeSkillRecorder } from "./skillRecorder.ts";

/** Records an explicit, user-started demonstration in local apps for skill authoring. */
export class DesktopSkillRecording extends Context.Service<
  DesktopSkillRecording,
  {
    readonly requestPermission: Effect.Effect<boolean>;
    readonly start: (ownerId: number) => Effect.Effect<DesktopSkillRecordingStartResult>;
    readonly stop: (
      sessionId: string,
      ownerId: number,
    ) => Effect.Effect<DesktopSkillRecordingStopResult>;
    readonly cancel: (sessionId: string, ownerId: number) => Effect.Effect<void>;
  }
>()("@t3tools/desktop/skillRecording/DesktopSkillRecording") {}

function watchWebContents(ownerId: number, onGone: () => void): () => void {
  const contents = Electron.webContents.fromId(ownerId);
  if (!contents || contents.isDestroyed()) {
    queueMicrotask(onGone);
    return () => undefined;
  }
  // A reload replaces the page that could stop or cancel the recording.
  const events = ["destroyed", "did-navigate", "render-process-gone"] as const;
  for (const event of events) contents.on(event as "destroyed", onGone);
  return () => {
    if (contents.isDestroyed()) return;
    for (const event of events) contents.off(event as "destroyed", onGone);
  };
}

/** Brings the window that started the recording forward, where the recording opens. */
function focusOwner(contents: Electron.WebContents, platform: NodeJS.Platform) {
  const window = Electron.BrowserWindow.fromWebContents(contents);
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
  if (platform === "darwin") Electron.app.focus({ steal: true });
}

const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const crypto = yield* Crypto.Crypto;
  const workerPath = environment.path.join(__dirname, "skillRecording", "SkillRecordingWorker.cjs");
  const hasPermission = () =>
    environment.platform !== "darwin" ||
    Electron.systemPreferences.isTrustedAccessibilityClient(false);
  // The page then collects a stopped capture, or resets after a discard.
  const control = (recording: ActiveRecording, action: SkillRecordingBarAction) => {
    // Both end capture here, so the bar works even if the page is unresponsive.
    if (action === "discard") recorder.cancel(recording.sessionId, recording.ownerId);
    else recorder.halt(recording.sessionId);
    const contents = Electron.webContents.fromId(recording.ownerId);
    if (!contents || contents.isDestroyed()) return;
    if (action === "stop") focusOwner(contents, environment.platform);
    contents.send(SKILL_RECORDING_CONTROL_CHANNEL, { sessionId: recording.sessionId, action });
  };
  const bar = makeSkillRecordingBar(environment.platform, control);
  const recorder = makeSkillRecorder({
    hasPermission,
    captureInput: environment.platform === "darwin",
    startProcess: (request) => startSkillRecordingProcess(workerPath, request),
    watchOwner: watchWebContents,
    onActiveChange: (recording) => (recording ? bar.show(recording) : bar.hide()),
    onCaptureEnded: (recording) => control(recording, "stop"),
  });
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      recorder.close();
      bar.hide();
    }),
  );

  return DesktopSkillRecording.of({
    requestPermission: Effect.sync(
      () =>
        environment.platform !== "darwin" ||
        Electron.systemPreferences.isTrustedAccessibilityClient(true),
    ),
    start: Effect.fn("DesktopSkillRecording.start")((ownerId) =>
      crypto.randomUUIDv4().pipe(
        Effect.flatMap((sessionId) => Effect.promise(() => recorder.start(ownerId, sessionId))),
        Effect.orElseSucceed(() => ({ status: "unavailable" as const })),
      ),
    ),
    stop: Effect.fn("DesktopSkillRecording.stop")((sessionId, ownerId) =>
      Effect.promise(() => recorder.stop(sessionId, ownerId)),
    ),
    cancel: Effect.fn("DesktopSkillRecording.cancel")((sessionId, ownerId) =>
      Effect.sync(() => recorder.cancel(sessionId, ownerId)),
    ),
  });
});

export const layer = Layer.effect(DesktopSkillRecording, make);
