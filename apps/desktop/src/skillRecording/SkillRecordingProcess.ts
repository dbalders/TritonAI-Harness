// @effect-diagnostics globalTimers:off -- Helper timeouts run at child-process callback boundaries outside Effect fibers.
// @effect-diagnostics nodeBuiltinImport:off -- This desktop-only helper owns a Node child process.

import * as NodeChildProcess from "node:child_process";

import type { DesktopSkillRecordingStep } from "@t3tools/contracts";

const START_TIMEOUT_MS = 5_000;
const STOP_TIMEOUT_MS = 5_000;

export type SkillRecordingFailure = "permission-required" | "unavailable";

export type SkillRecordingWorkerRequest =
  | {
      readonly type: "start";
      readonly maxSteps: number;
      readonly maxDurationMs: number;
      /** Also record clicks and shortcuts; macOS only. */
      readonly captureInput: boolean;
    }
  | { readonly type: "stop" };

export type SkillRecordingWorkerMessage =
  | { readonly type: "ready" }
  | { readonly type: "started" }
  | {
      readonly type: "result";
      readonly durationMs: number;
      readonly steps: ReadonlyArray<DesktopSkillRecordingStep>;
      readonly limitReached: "time" | "steps" | null;
    }
  | { readonly type: "error"; readonly reason: SkillRecordingFailure };

export type SkillRecordingStarted =
  | { readonly status: "recording" }
  | { readonly status: SkillRecordingFailure };

export type SkillRecordingCapture =
  | {
      readonly status: "stopped";
      readonly durationMs: number;
      readonly steps: ReadonlyArray<DesktopSkillRecordingStep>;
      readonly limitReached: "time" | "steps" | null;
    }
  | { readonly status: "failed" };

export type SkillRecordingProcess = {
  readonly started: Promise<SkillRecordingStarted>;
  /** Asks the helper for its capture, then ends it. Safe to call once. */
  readonly stop: () => Promise<SkillRecordingCapture>;
  /** Ends the helper and drops anything it captured. */
  readonly cancel: () => void;
};

function forkWorker(workerPath: string) {
  return NodeChildProcess.fork(workerPath, [], {
    // Electron defaults to its Helper executable on macOS, which does not
    // share the main app's Accessibility grant.
    execPath: process.execPath,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    execArgv: [],
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
}

export function startSkillRecordingProcess(
  workerPath: string,
  request: Extract<SkillRecordingWorkerRequest, { type: "start" }>,
): SkillRecordingProcess {
  let worker: NodeChildProcess.ChildProcess;
  try {
    worker = forkWorker(workerPath);
  } catch {
    return {
      started: Promise.resolve({ status: "unavailable" }),
      stop: () => Promise.resolve({ status: "failed" }),
      cancel: () => undefined,
    };
  }

  const started = Promise.withResolvers<SkillRecordingStarted>();
  const capture = Promise.withResolvers<SkillRecordingCapture>();
  let ended = false;
  let stopTimeout: ReturnType<typeof setTimeout> | undefined;
  const startTimeout = setTimeout(() => end(), START_TIMEOUT_MS);
  startTimeout.unref();

  // Every exit path settles both promises, so no caller waits on a dead helper.
  function end(failure: SkillRecordingFailure = "unavailable") {
    if (ended) return;
    ended = true;
    clearTimeout(startTimeout);
    if (stopTimeout) clearTimeout(stopTimeout);
    worker.kill();
    started.resolve({ status: failure });
    capture.resolve({ status: "failed" });
  }
  const send = (message: SkillRecordingWorkerRequest) => {
    try {
      worker.send(message, (error) => {
        if (error) end();
      });
    } catch {
      end();
    }
  };

  worker.on("message", (raw) => {
    if (ended) return;
    const message = raw as SkillRecordingWorkerMessage;
    switch (message.type) {
      case "ready":
        send(request);
        return;
      case "started":
        clearTimeout(startTimeout);
        started.resolve({ status: "recording" });
        return;
      case "result":
        capture.resolve({
          status: "stopped",
          durationMs: message.durationMs,
          steps: message.steps,
          limitReached: message.limitReached,
        });
        end();
        return;
      case "error":
        end(message.reason);
        return;
      default:
        return;
    }
  });
  worker.once("error", () => end());
  worker.once("exit", () => end());

  return {
    started: started.promise,
    stop: () => {
      if (!ended && !stopTimeout) {
        stopTimeout = setTimeout(() => end(), STOP_TIMEOUT_MS);
        stopTimeout.unref();
        send({ type: "stop" });
      }
      return capture.promise;
    },
    cancel: () => end(),
  };
}
