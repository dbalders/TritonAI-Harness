import { assert, beforeEach, it } from "@effect/vitest";
import * as NodeEvents from "node:events";
import { vi } from "vite-plus/test";

const forkMock = vi.hoisted(() => vi.fn<(...args: ReadonlyArray<unknown>) => unknown>());
vi.mock("node:child_process", () => ({ fork: forkMock }));

import { startSkillRecordingProcess } from "./SkillRecordingProcess.ts";

const makeWorker = () =>
  Object.assign(new NodeEvents.EventEmitter(), {
    kill: vi.fn(() => true),
    send: vi.fn(),
  });
let worker = makeWorker();
const request = {
  type: "start",
  maxSteps: 10,
  maxDurationMs: 1_000,
  captureInput: false,
} as const;

beforeEach(() => {
  worker = makeWorker();
  forkMock.mockReset().mockReturnValue(worker);
});

it("sends the start request only after the helper is ready and returns its capture", async () => {
  const recording = startSkillRecordingProcess("worker.cjs", request);
  assert.strictEqual(worker.send.mock.calls.length, 0);
  worker.emit("message", { type: "ready" });
  assert.deepEqual(worker.send.mock.calls[0]?.[0], request);
  worker.emit("message", { type: "started" });
  assert.deepEqual(await recording.started, { status: "recording" });

  const stopped = recording.stop();
  assert.deepEqual(worker.send.mock.calls[1]?.[0], { type: "stop" });
  worker.emit("message", { type: "result", durationMs: 5, steps: [], limitReached: null });
  assert.deepEqual(await stopped, {
    status: "stopped",
    durationMs: 5,
    steps: [],
    limitReached: null,
  });
  assert.strictEqual(worker.kill.mock.calls.length, 1);
});

it("settles start and stop when the helper crashes mid-recording", async () => {
  const recording = startSkillRecordingProcess("worker.cjs", request);
  worker.emit("message", { type: "ready" });
  worker.emit("message", { type: "started" });
  await recording.started;
  worker.emit("exit", null, "SIGABRT");
  assert.deepEqual(await recording.stop(), { status: "failed" });
});

it("passes through why the helper could not record the app", async () => {
  const recording = startSkillRecordingProcess("worker.cjs", request);
  worker.emit("message", { type: "ready" });
  worker.emit("message", { type: "error", reason: "app-not-found" });
  assert.deepEqual(await recording.started, { status: "app-not-found" });
});

it("ignores a late result after cancel", async () => {
  const recording = startSkillRecordingProcess("worker.cjs", request);
  worker.emit("message", { type: "ready" });
  worker.emit("message", { type: "started" });
  recording.cancel();
  worker.emit("message", {
    type: "result",
    durationMs: 5,
    steps: [{ atMs: 0, kind: "focus", role: "button", name: "Secret", value: null }],
    limitReached: null,
  });
  assert.deepEqual(await recording.stop(), { status: "failed" });
});
