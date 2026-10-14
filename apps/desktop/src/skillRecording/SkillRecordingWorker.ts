// @effect-diagnostics globalDate:off globalTimers:off -- This helper process runs outside Effect.

import { loadMacSkillInput } from "./MacSkillInput.ts";
import { makeSkillInputSampler } from "./skillRecordingInput.ts";
import {
  makeSkillRecordingBuffer,
  type RecordedAccessibilityEvent,
} from "./skillRecordingSteps.ts";
import type {
  SkillRecordingFailure,
  SkillRecordingWorkerMessage,
  SkillRecordingWorkerRequest,
} from "./SkillRecordingProcess.ts";

process.once("disconnect", () => process.exit(0));

const INPUT_POLL_INTERVAL_MS = 10;
const FOLLOW_INTERVAL_MS = 200;

type Xa11y = typeof import("@crowecawcaw/xa11y");
type NativeEvent = InstanceType<Xa11y["Event"]>;

const send = (message: SkillRecordingWorkerMessage, exit = false) => {
  process.send?.(message, undefined, undefined, () => {
    if (exit) process.exit(0);
  });
};

function failureReason(error: unknown): SkillRecordingFailure {
  const name = error instanceof Error ? error.name : "";
  if (name === "PermissionDeniedError" || name === "AccessibilityNotEnabledError") {
    return "permission-required";
  }
  return "unavailable";
}

function read<A>(getter: () => A, fallback: A): A {
  try {
    return getter();
  } catch {
    return fallback;
  }
}

/** Copies the native event's getters once; each read crosses into the platform API. */
function snapshotEvent(event: NativeEvent): RecordedAccessibilityEvent {
  const target = read(() => event.target, null);
  return {
    type: read(() => event.type, ""),
    stateFlag: read(() => event.stateFlag, null),
    stateValue: read(() => event.stateValue, null),
    target: target
      ? {
          role: read(() => target.role, ""),
          name: read(() => target.name, null),
          value: read(() => target.value, null),
          editable: read(() => target.editable, true),
          focused: read(() => target.focused, null),
          stableId: read(() => target.stableId, null),
          raw: read(() => target.raw, {}),
        }
      : null,
  };
}

type MacInput = Awaited<ReturnType<typeof loadMacSkillInput>>;

/**
 * Polls for clicks and shortcuts in one app. Recording carries on with
 * accessibility events alone if the native reads fail.
 */
function startInputCapture(
  native: MacInput,
  pid: number,
  buffer: ReturnType<typeof makeSkillRecordingBuffer>,
  elapsed: () => number,
  afterInput: () => void,
): () => void {
  const api = native.forApp(pid);
  const sample = makeSkillInputSampler(api, pid, elapsed);
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    api.close();
  };
  const timer = setInterval(() => {
    try {
      for (const candidate of sample()) buffer.addInput(candidate.step, candidate.atMs);
      afterInput();
    } catch {
      stop();
    }
  }, INPUT_POLL_INTERVAL_MS);
  return stop;
}

async function record() {
  const { App } = await import("@crowecawcaw/xa11y");
  send({ type: "ready" });
  const request = await new Promise<Extract<SkillRecordingWorkerRequest, { type: "start" }>>(
    (resolve) => {
      const onMessage = (message: SkillRecordingWorkerRequest) => {
        if (message.type !== "start") return;
        process.off("message", onMessage);
        resolve(message);
      };
      process.on("message", onMessage);
    },
  );
  const native = request.captureInput ? await loadMacSkillInput().catch(() => null) : null;
  const buffer = makeSkillRecordingBuffer(request);
  // One clock for accessibility events and polled input keeps their order.
  const startedAt = performance.now();
  const elapsed = () => performance.now() - startedAt;
  let ended = false;
  // The app in front, and how to stop listening to it.
  let followed: { readonly pid: number; readonly close: () => void } | null = null;
  let lastRecordedPid: number | null = null;
  let followTimer: ReturnType<typeof setTimeout> | undefined;
  const end = () => {
    if (ended) return;
    ended = true;
    clearTimeout(limitTimer);
    clearTimeout(followTimer);
    followed?.close();
    followed = null;
    native?.close();
  };
  // Capture stops at the step cap instead of reading events it can't keep.
  const endIfFull = () => {
    if (buffer.isFull()) end();
  };
  const limitTimer = setTimeout(() => {
    buffer.markTimeLimit();
    end();
  }, request.maxDurationMs);

  /**
   * Moves to whichever app is in front. Harness itself is never recorded, and
   * returning to the last recorded app after it doesn't count as a switch.
   */
  const follow = async () => {
    const front = await App.foreground({ timeout: 0 }).catch(() => null);
    if (ended) return;
    const pid = front?.pid ?? null;
    if (pid === (followed?.pid ?? null)) return;
    followed?.close();
    followed = null;
    if (!front || pid === null || pid === process.ppid) return;
    if (pid !== lastRecordedPid) {
      lastRecordedPid = pid;
      buffer.addApp(front.name, elapsed());
      endIfFull();
      if (ended) return;
    }
    const subscription = await front.subscribe().catch(() => null);
    if (ended) {
      subscription?.close();
      return;
    }
    subscription?.on("event", (event) => {
      if (ended || followed?.pid !== pid) return;
      buffer.add(snapshotEvent(event), elapsed());
      endIfFull();
    });
    const stopInput = native
      ? startInputCapture(native, pid, buffer, elapsed, endIfFull)
      : () => undefined;
    followed = {
      pid,
      close: () => {
        stopInput();
        subscription?.close();
      },
    };
  };
  const followLoop = () => {
    void follow()
      .catch(() => undefined)
      .then(() => {
        if (!ended) followTimer = setTimeout(followLoop, FOLLOW_INTERVAL_MS);
      });
  };
  followLoop();

  process.on("message", (message: SkillRecordingWorkerRequest) => {
    if (message.type !== "stop") return;
    end();
    const durationMs = Math.min(Math.round(elapsed()), request.maxDurationMs);
    send({ type: "result", durationMs, ...buffer.finish() }, true);
  });
  send({ type: "started" });
}

void record().catch((error: unknown) =>
  send({ type: "error", reason: failureReason(error) }, true),
);
