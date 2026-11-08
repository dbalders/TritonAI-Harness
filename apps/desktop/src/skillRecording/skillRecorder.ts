import type {
  DesktopSkillRecordingStartResult,
  DesktopSkillRecordingStopResult,
} from "@t3tools/contracts";

import type {
  SkillRecordingProcess,
  SkillRecordingWorkerRequest,
} from "./SkillRecordingProcess.ts";
import {
  SKILL_RECORDING_MAX_DURATION_MS,
  SKILL_RECORDING_MAX_STEPS,
} from "./skillRecordingSteps.ts";

export type SkillRecorderDependencies = {
  readonly hasPermission: () => boolean;
  /** Whether this platform can also record clicks and shortcuts. */
  readonly captureInput: boolean;
  readonly startProcess: (
    request: Extract<SkillRecordingWorkerRequest, { type: "start" }>,
  ) => SkillRecordingProcess;
  /** Calls `onGone` when the window that started a recording closes or reloads. */
  readonly watchOwner: (ownerId: number, onGone: () => void) => () => void;
  /** Shows the recording while it runs, and hides it once it ends for any reason. */
  readonly onActiveChange: (recording: ActiveRecording | null) => void;
  /** Capture ended without Stop, at a limit or because the helper failed; stop it like Stop would. */
  readonly onCaptureEnded: (recording: ActiveRecording) => void;
};

export type ActiveRecording = {
  readonly sessionId: string;
  readonly ownerId: number;
  readonly maxDurationMs: number;
};

type ActiveSession = {
  readonly id: string;
  readonly ownerId: number;
  readonly process: SkillRecordingProcess;
  readonly unwatch: () => void;
  started: boolean;
};

/**
 * Owns at most one demonstration at a time. A recording only starts from an
 * explicit request, ends when its window goes away, and its capture is only
 * ever handed back to the window that started it.
 */
export function makeSkillRecorder(dependencies: SkillRecorderDependencies) {
  let active: ActiveSession | undefined;
  // Recordings halted from the floating bar, waiting for their windows to collect them.
  const halted = new Map<
    string,
    {
      readonly ownerId: number;
      readonly result: Promise<DesktopSkillRecordingStopResult>;
      readonly unwatch: () => void;
    }
  >();
  const dropHalted = (sessionId: string) => {
    halted.get(sessionId)?.unwatch();
    halted.delete(sessionId);
  };

  const finishCapture = async (
    session: ActiveSession,
  ): Promise<DesktopSkillRecordingStopResult> => {
    const capture = await session.process.stop();
    if (capture.status !== "stopped") return { status: "failed" };
    return {
      status: "stopped",
      durationMs: capture.durationMs,
      steps: capture.steps,
      limitReached: capture.limitReached,
    };
  };

  const release = (session: ActiveSession) => {
    if (active !== session) return false;
    active = undefined;
    session.unwatch();
    if (session.started) dependencies.onActiveChange(null);
    return true;
  };
  const discard = (session: ActiveSession) => {
    if (release(session)) session.process.cancel();
  };

  return {
    start: async (
      ownerId: number,
      sessionId: string,
    ): Promise<DesktopSkillRecordingStartResult> => {
      if (active) return { status: "busy" };
      if (!dependencies.hasPermission()) return { status: "permission-required" };
      const request = {
        type: "start",
        maxSteps: SKILL_RECORDING_MAX_STEPS,
        maxDurationMs: SKILL_RECORDING_MAX_DURATION_MS,
        captureInput: dependencies.captureInput,
      } as const;
      let session: ActiveSession | undefined;
      const process = dependencies.startProcess(request);
      const created: ActiveSession = {
        id: sessionId,
        ownerId,
        process,
        started: false,
        unwatch: dependencies.watchOwner(ownerId, () => {
          if (session) discard(session);
        }),
      };
      session = created;
      active = created;
      const started = await process.started;
      if (active !== created) return { status: "unavailable" };
      if (started.status !== "recording") {
        discard(created);
        return { status: started.status };
      }
      created.started = true;
      const recording = {
        sessionId: created.id,
        ownerId,
        maxDurationMs: request.maxDurationMs,
      };
      dependencies.onActiveChange(recording);
      // Stop, Discard, and a closed window release the session first, so only
      // capture ending by itself gets here.
      void process.ended.then(() => {
        if (active === created) dependencies.onCaptureEnded(recording);
      });
      return {
        status: "recording",
        sessionId: created.id,
        maxDurationMs: request.maxDurationMs,
        maxSteps: request.maxSteps,
      };
    },

    stop: async (sessionId: string, ownerId: number): Promise<DesktopSkillRecordingStopResult> => {
      const held = halted.get(sessionId);
      if (held && held.ownerId === ownerId) {
        dropHalted(sessionId);
        return held.result;
      }
      const session = active;
      if (!session || session.id !== sessionId || session.ownerId !== ownerId || !session.started) {
        return { status: "not-found" };
      }
      release(session);
      return finishCapture(session);
    },

    /**
     * Ends capture now, without waiting for the window that started it, and
     * keeps the result for that window's `stop` until the window goes away.
     */
    halt: (sessionId: string) => {
      const session = active;
      if (!session || session.id !== sessionId || !session.started) return;
      release(session);
      halted.set(session.id, {
        ownerId: session.ownerId,
        result: finishCapture(session),
        unwatch: dependencies.watchOwner(session.ownerId, () => dropHalted(session.id)),
      });
    },

    cancel: (sessionId: string, ownerId: number) => {
      if (active && active.id === sessionId && active.ownerId === ownerId) discard(active);
      if (halted.get(sessionId)?.ownerId === ownerId) dropHalted(sessionId);
    },

    close: () => {
      if (active) discard(active);
      // Deleting the current entry while iterating a Map is safe.
      for (const sessionId of halted.keys()) dropHalted(sessionId);
    },
  };
}
